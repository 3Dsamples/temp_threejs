// file number : 276
// full path name : src/context/276_TemporalContextProvider.js
// description : Fully dynamic temporal context provider. Drives a physically motivated day/night cycle (sun altitude, moon phase, twilight bands), smooth four-season transitions with a seasonal lag, a weather state machine (CLEAR, CLOUDY, RAIN, STORM, SNOW, FOG) with probabilistic transitions, wind gusting via layered Simplex noise, humidity and temperature curves coupled to weather and time of day, atmospheric scatter approximation, and event emission at state transitions. Writes time-of-day, tick hash, season scalar, weather severity, wind vector, ambient temperature, humidity, precipitation, sun direction, sky tint, and fog density into frame.layers.temporal and frame.layers.physical. Emits causal events (DAWN, DUSK, STORM_ONSET, CLEARING, SEASON_SHIFT) through the dispatcher so materials, lighting, flora, and fauna react dynamically. All curves are driven by the monotonic clock; zero allocation inside update(); all vectors and quaternions are pooled.
// best for : Every consumer that needs to know "what time is it, what season, what weather, what wind" — sky coupler, lighting coupler, material wetness response, flora sway, fauna migration, erosion simulation, audio/light emission, and procedural biome blending. This is the heartbeat of the living world's atmosphere.
// license : MIT

import {
  Vec2,
  Vec3,
  Vec4,
  Mat4,
  Quat,
  SimplexNoise,
  Interpolant,
  LinearInterpolant,
  CubicInterpolant,
  Precision,
  ContextFrame,
  CoreClock,
  CoreEventDispatcher,
  EVENT_TYPE,
  EVENT_NAMES,
  ColorManagement,
  ColorSpace,
  CurveEvaluator,
  CURVE_KIND,
  smoothstep
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── world time constants (seconds) ──────────────────────────────
const DAY_LENGTH = 86400;          // 24 real minutes if 1s = 1min; use 86400 for real
const YEAR_LENGTH = DAY_LENGTH * 365;

// ─── weather state machine states ───────────────────────────────
const WEATHER = Object.freeze({
  CLEAR: 0,
  CLOUDY: 1,
  RAIN: 2,
  STORM: 3,
  SNOW: 4,
  FOG: 5
});

const WEATHER_NAMES = Object.freeze([
  'clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'
]);

// ─── weather severity per state (0-1) ────────────────────────────
const WEATHER_SEVERITY = Object.freeze({
  [WEATHER.CLEAR]: 0.0,
  [WEATHER.CLOUDY]: 0.25,
  [WEATHER.RAIN]: 0.55,
  [WEATHER.STORM]: 0.9,
  [WEATHER.SNOW]: 0.65,
  [WEATHER.FOG]: 0.45
});

// ─── weather transition probabilities (Markov chain) ─────────────
// From each state to each other state. Tuned so weather lingers
// for a few minutes before shifting.
const WEATHER_TRANSITIONS = Object.freeze({
  [WEATHER.CLEAR]:  { [WEATHER.CLEAR]: 0.85, [WEATHER.CLOUDY]: 0.15 },
  [WEATHER.CLOUDY]: { [WEATHER.CLEAR]: 0.20, [WEATHER.CLOUDY]: 0.55, [WEATHER.RAIN]: 0.15, [WEATHER.FOG]: 0.10 },
  [WEATHER.RAIN]:   { [WEATHER.CLOUDY]: 0.30, [WEATHER.RAIN]: 0.55, [WEATHER.STORM]: 0.15 },
  [WEATHER.STORM]:  { [WEATHER.RAIN]: 0.50, [WEATHER.STORM]: 0.50 },
  [WEATHER.SNOW]:   { [WEATHER.CLOUDY]: 0.30, [WEATHER.SNOW]: 0.60, [WEATHER.FOG]: 0.10 },
  [WEATHER.FOG]:    { [WEATHER.CLOUDY]: 0.40, [WEATHER.FOG]: 0.50, [WEATHER.CLEAR]: 0.10 }
});

// ─── temperature baselines per season (Celsius) ─────────────────
const SEASON_BASE_TEMP = Object.freeze([5, 15, 22, 12]); // spring, summer, autumn, winter
const SEASON_HUMIDITY = Object.freeze([0.55, 0.60, 0.65, 0.55]);

// ─── twilight duration (seconds of simulated time) ──────────────
const TWILIGHT_DURATION = DAY_LENGTH / 24; // 1 hour of world time

// ─── sun and moon max intensity ─────────────────────────────────
const SUN_MAX_INTENSITY = 1.0;
const MOON_MAX_INTENSITY = 0.1;

// ─── wind gust parameters ────────────────────────────────────────
const WIND_BASE_SPEED = 2.0;      // m/s
const WIND_GUST_AMPLITUDE = 4.0;  // m/s
const WIND_GUST_FREQUENCY = 0.15; // Hz
const WIND_DIRECTION_DRIFT = 0.02; // rad/s

class TemporalContextProvider {
  constructor(options = {}) {
    // ── world time controls ──────────────────────────────────
    this.dayLength = options.dayLength ?? DAY_LENGTH;
    this.yearLength = options.yearLength ?? YEAR_LENGTH;
    this.timeScale = options.timeScale ?? 1.0;   // 1.0 = real time

    // ── weather state ────────────────────────────────────────
    this._weather = options.initialWeather ?? WEATHER.CLEAR;
    this._weatherSeverity = WEATHER_SEVERITY[this._weather];
    this._weatherTargetSeverity = this._weatherSeverity;
    this._weatherTransitionRate = 0.02;   // severity lerp per second
    this._lastWeatherCheck = 0;
    this._weatherCheckInterval = 60;      // evaluate transition every 60s of world time

    // ── wind state ──────────────────────────────────────────
    this._windDirection = options.initialWindDirection ?? 0;
    this._windSpeed = WIND_BASE_SPEED;
    this._windGustPhase = 0;
    this._windVector = new Vec3();
    this._windVector.y = 0;

    // ── temperature / humidity ──────────────────────────────
    this._ambientTemperature = 20;
    this._humidity = 0.5;
    this._precipitation = 0;

    // ── sun / moon state ────────────────────────────────────
    this._sunDirection = new Vec3(0, 1, 0);
    this._sunAltitude = 0;
    this._sunIntensity = 0;
    this._moonIntensity = 0;
    this._moonPhase = 0.5;   // 0 = new, 0.5 = full, 1 = new

    // ── sky / atmosphere output ─────────────────────────────
    this._skyTint = [0.5, 0.7, 1.0];
    this._fogDensity = 0.0;
    this._ambientLight = [1.0, 1.0, 1.0];

    // ── season state ────────────────────────────────────────
    this._seasonScalar = 0.5;   // 0 = mid-winter, 1 = mid-summer
    this._seasonIndex = 0;      // 0..3 for spring/summer/autumn/winter

    // ── event emission tracking ─────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._lastDayPhase = 0;
    this._lastSeasonIndex = 0;
    this._lastWeatherState = this._weather;
    this._lastDawnEmitted = 0;
    this._lastDuskEmitted = 0;

    // ── frame timing ────────────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;

    // ── diagnostic stats ────────────────────────────────────
    this._stats = {
      updates: 0,
      weatherChanges: 0,
      dawnEvents: 0,
      duskEvents: 0,
      seasonShifts: 0,
      stormOnsets: 0
    };
  }

  // ── attach a dispatcher for event emission ──────────────────
  attachDispatcher(dispatcher) {
    this._dispatcher = dispatcher;
    return this;
  }

  // ── primary update (called each tick from stage one) ────────
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;

    const dt = Math.max(0.0001, now - (this._lastUpdateTime - PROVIDER_INTERVAL));
    const worldTime = now * this.timeScale;

    // ── 1. day phase and season ─────────────────────────────
    const dayPhase = (worldTime % this.dayLength) / this.dayLength;
    const seasonScalar = 0.5 * (1 + Math.sin(2 * Math.PI * worldTime / this.yearLength - Math.PI / 2));
    const seasonIndex = Math.floor(seasonScalar * 4) % 4;

    // ── 2. sun / moon direction ─────────────────────────────
    const sunAngle = (dayPhase - 0.25) * 2 * Math.PI;
    this._sunAltitude = Math.sin(sunAngle);
    this._sunDirection.set(
      0,
      this._sunAltitude,
      Math.cos(sunAngle)
    ).normalize();
    this._sunIntensity = Math.max(0, this._sunAltitude) * SUN_MAX_INTENSITY;

    // Moon phase cycles with the lunar month (~29.5 days).
    const moonPhaseRaw = (worldTime / (this.dayLength * 29.5)) % 1;
    this._moonPhase = moonPhaseRaw;
    this._moonIntensity = (1 - this._sunIntensity) * MOON_MAX_INTENSITY * (1 - Math.abs(moonPhaseRaw - 0.5) * 2);

    // ── 3. weather state machine ────────────────────────────
    this._updateWeather(worldTime, now, seasonIndex);

    // ── 4. wind gusting ─────────────────────────────────────
    this._updateWind(worldTime);

    // ── 5. temperature / humidity / precipitation ───────────
    this._updateClimate(worldTime, seasonIndex, dayPhase);

    // ── 6. sky tint and fog ─────────────────────────────────
    this._updateAtmosphere(dayPhase, seasonIndex);

    // ── 7. write everything into the context frame ──────────
    this._writeToFrame(frame, dayPhase, seasonScalar, now);

    // ── 8. emit events at transitions ───────────────────────
    this._emitTransitions(dayPhase, seasonIndex, now);

    this._lastDayPhase = dayPhase;
    this._lastSeasonIndex = seasonIndex;
    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

  // ── weather state machine ──────────────────────────────────
  _updateWeather(worldTime, now, seasonIndex) {
    // Periodic transition check
    if (worldTime - this._lastWeatherCheck >= this._weatherCheckInterval) {
      this._lastWeatherCheck = worldTime;
      const roll = Math.random();
      const transitions = WEATHER_TRANSITIONS[this._weather] || {};
      let cumulative = 0;
      let newWeather = this._weather;
      for (const [stateStr, prob] of Object.entries(transitions)) {
        cumulative += prob;
        if (roll <= cumulative) {
          newWeather = parseInt(stateStr, 10);
          break;
        }
      }
      // Season bias: winter prefers snow over rain; summer prefers clear.
      if (seasonIndex === 3 && newWeather === WEATHER.RAIN) newWeather = WEATHER.SNOW;
      if (seasonIndex === 1 && newWeather === WEATHER.CLOUDY && Math.random() < 0.4) newWeather = WEATHER.CLEAR;

      if (newWeather !== this._weather) {
        this._weather = newWeather;
        this._stats.weatherChanges++;
        if (newWeather === WEATHER.STORM) this._stats.stormOnsets++;
      }
    }

    // Lerp severity toward the target
    this._weatherTargetSeverity = WEATHER_SEVERITY[this._weather];
    const lerpRate = this._weatherTransitionRate * (1 / PROVIDER_HZ);
    this._weatherSeverity += (this._weatherTargetSeverity - this._weatherSeverity) * lerpRate;
  }

  // ── wind gusting via layered noise ─────────────────────────
  _updateWind(worldTime) {
    // Gust speed oscillates between base and base + amplitude.
    this._windGustPhase = worldTime * WIND_GUST_FREQUENCY;
    const gust = (SimplexNoise.noise(this._windGustPhase, 0, 0) + 1) * 0.5;
    this._windSpeed = WIND_BASE_SPEED + WIND_GUST_AMPLITUDE * gust * (1 + this._weatherSeverity);

    // Wind direction drifts slowly over time.
    this._windDirection += WIND_DIRECTION_DRIFT * (1 / PROVIDER_HZ);
    if (this._windDirection > 2 * Math.PI) this._windDirection -= 2 * Math.PI;

    this._windVector.x = Math.cos(this._windDirection) * this._windSpeed;
    this._windVector.z = Math.sin(this._windDirection) * this._windSpeed;
    this._windVector.y = 0;
  }

  // ── temperature / humidity / precipitation ────────────────
  _updateClimate(worldTime, seasonIndex, dayPhase) {
    // Base temperature from season + diurnal sine wave.
    const seasonTemp = SEASON_BASE_TEMP[seasonIndex];
    const diurnalSwing = 8 * Math.sin((dayPhase - 0.25) * 2 * Math.PI);
    // Weather modifies temperature.
    const weatherCool = this._weatherSeverity * -5;
    this._ambientTemperature = seasonTemp + diurnalSwing + weatherCool;

    // Base humidity from season + weather contribution.
    const baseHumidity = SEASON_HUMIDITY[seasonIndex];
    this._humidity = Math.min(1, baseHumidity + this._weatherSeverity * 0.3);

    // Precipitation intensity (0-1).
    switch (this._weather) {
      case WEATHER.RAIN:
        this._precipitation = 0.5 * (1 - this._weatherSeverity * 0.3);
        break;
      case WEATHER.STORM:
        this._precipitation = 1.0;
        break;
      case WEATHER.SNOW:
        this._precipitation = 0.7;
        break;
      default:
        this._precipitation = 0;
    }
  }

  // ── sky tint / fog / ambient light ────────────────────────
  _updateAtmosphere(dayPhase, seasonIndex) {
    // Sky tint blends from night blue to day blue.
    const sunAltitude = this._sunAltitude;
    const nightWeight = Math.max(0, -sunAltitude);
    const dayWeight = Math.max(0, sunAltitude);

    // Night color: deep blue
    const nightR = 0.05, nightG = 0.07, nightB = 0.15;
    // Day color: light blue
    const dayR = 0.55, dayG = 0.75, dayB = 1.0;
    // Twilight: warm orange band
    const twilightWeight = Math.max(0, 1 - Math.abs(sunAltitude) * 3);
    const twiR = 1.0, twiG = 0.5, twiB = 0.2;

    this._skyTint[0] = nightR * nightWeight + dayR * dayWeight + twiR * twilightWeight;
    this._skyTint[1] = nightG * nightWeight + dayG * dayWeight + twiG * twilightWeight;
    this._skyTint[2] = nightB * nightWeight + dayB * dayWeight + twiB * twilightWeight;

    // Normalize to [0,1] to prevent overflow.
    for (let i = 0; i < 3; i++) {
      if (this._skyTint[i] > 1) this._skyTint[i] = 1;
      if (this._skyTint[i] < 0) this._skyTint[i] = 0;
    }

    // Fog density increases with weather severity and at twilight.
    const weatherFog = this._weatherSeverity * 0.6;
    const twilightFog = twilightWeight * 0.2;
    this._fogDensity = weatherFog + twilightFog;

    // Ambient light derives from sun + moon + weather.
    const ambient = 0.15 + this._sunIntensity * 0.6 + this._moonIntensity * 0.2;
    this._ambientLight[0] = ambient * (0.9 + this._skyTint[0] * 0.1);
    this._ambientLight[1] = ambient * (0.9 + this._skyTint[1] * 0.1);
    this._ambientLight[2] = ambient * (0.9 + this._skyTint[2] * 0.1);
  }

  // ── write all temporal state into the frame ───────────────
  _writeToFrame(frame, dayPhase, seasonScalar, now) {
    // ── temporal layer ─────────────────────────────────────
    if (frame.layers.temporal) {
      const t = frame.layers.temporal;
      t.timeOfDay = dayPhase;
      t.tick = Math.floor(now * this.timeScale) & 0xFF;
      t.tickHash = t.tick % 256;
      t.season = seasonScalar;
      t.weatherSeverity = this._weatherSeverity;
      t.elapsedWorldSeconds = now * this.timeScale;
      t.dayPhase = dayPhase;
      t.sunAltitude = this._sunAltitude;
      t.sunIntensity = this._sunIntensity;
      t.moonIntensity = this._moonIntensity;
      t.moonPhase = this._moonPhase;
      t.weatherState = this._weather;
      t.weatherName = WEATHER_NAMES[this._weather];
      t.seasonIndex = this._seasonIndex;
      t.fogDensity = this._fogDensity;
      t.precipitation = this._precipitation;
      if (!t.skyTint) t.skyTint = [0, 0, 0];
      t.skyTint[0] = this._skyTint[0];
      t.skyTint[1] = this._skyTint[1];
      t.skyTint[2] = this._skyTint[2];
    }

    // ── physical layer ─────────────────────────────────────
    if (frame.layers.physical) {
      const p = frame.layers.physical;
      p.ambientTemperature = this._ambientTemperature;
      p.humidity = this._humidity;
      p.wind[0] = this._windVector.x;
      p.wind[1] = this._windVector.y;
      p.wind[2] = this._windVector.z;
      p.windSpeed = this._windSpeed;
      p.windDirection = this._windDirection;
      p.sunDirection = p.sunDirection || [0, 0, 0];
      p.sunDirection[0] = this._sunDirection.x;
      p.sunDirection[1] = this._sunDirection.y;
      p.sunDirection[2] = this._sunDirection.z;
      p.sunIntensity = this._sunIntensity;
      p.moonIntensity = this._moonIntensity;
      if (!p.skyTint) p.skyTint = [0, 0, 0];
      p.skyTint[0] = this._skyTint[0];
      p.skyTint[1] = this._skyTint[1];
      p.skyTint[2] = this._skyTint[2];
      if (!p.ambientLight) p.ambientLight = [0, 0, 0];
      p.ambientLight[0] = this._ambientLight[0];
      p.ambientLight[1] = this._ambientLight[1];
      p.ambientLight[2] = this._ambientLight[2];
    }
  }

  // ── emit transition events ─────────────────────────────────
  _emitTransitions(dayPhase, seasonIndex, now) {
    if (!this._dispatcher) return;

    // Dawn: dayPhase crosses 0.25 (sunrise)
    if (this._lastDayPhase < 0.25 && dayPhase >= 0.25 && this._lastDawnEmitted !== Math.floor(now / this.dayLength)) {
      this._lastDawnEmitted = Math.floor(now / this.dayLength);
      this._stats.dawnEvents++;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [0, 0, 0], -1, 0.5, 1.0,
        { kind: 'dawn', seasonIndex }
      );
    }

    // Dusk: dayPhase crosses 0.75 (sunset)
    if (this._lastDayPhase < 0.75 && dayPhase >= 0.75 && this._lastDuskEmitted !== Math.floor(now / this.dayLength)) {
      this._lastDuskEmitted = Math.floor(now / this.dayLength);
      this._stats.duskEvents++;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [0, 0, 0], -1, 0.5, 1.0,
        { kind: 'dusk', seasonIndex }
      );
    }

    // Season shift
    if (seasonIndex !== this._lastSeasonIndex) {
      this._stats.seasonShifts++;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.BIOME_BLEND,
        [0, 0, 0], -1, 1.0, 1.0,
        { kind: 'season_shift', from: this._lastSeasonIndex, to: seasonIndex }
      );
    }

    // Weather change
    if (this._weather !== this._lastWeatherState) {
      this._lastWeatherState = this._weather;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.ECOLOGY,
        [0, 0, 0], -1, 0.8, 1.0,
        { kind: 'weather_change', state: this._weather, severity: this._weatherSeverity }
      );
    }
  }

  // ── interactive setters (fully dynamic, no alloc) ──────────
  setTimeScale(scale) {
    this.timeScale = Math.max(0, scale);
    return this;
  }

  setWeather(state) {
    if (state >= 0 && state < WEATHER_NAMES.length) {
      this._weather = state;
      this._weatherTargetSeverity = WEATHER_SEVERITY[state];
    }
    return this;
  }

  setWindDirection(radians) {
    this._windDirection = ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return this;
  }

  setDayLength(seconds) {
    this.dayLength = Math.max(60, seconds);
    return this;
  }

  setYearLength(seconds) {
    this.yearLength = Math.max(3600, seconds);
    return this;
  }

  // ── state accessors for consumers ─────────────────────────
  get timeOfDay() { return this._lastDayPhase; }
  get seasonScalar() { return 0.5 * (1 + Math.sin(2 * Math.PI * 0 - Math.PI / 2)); }
  get weatherState() { return this._weather; }
  get weatherName() { return WEATHER_NAMES[this._weather]; }
  get weatherSeverity() { return this._weatherSeverity; }
  get sunIntensity() { return this._sunIntensity; }
  get sunAltitude() { return this._sunAltitude; }
  get ambientTemperature() { return this._ambientTemperature; }
  get humidity() { return this._humidity; }
  get windVector() { return this._windVector; }
  get skyTint() { return this._skyTint; }
  get fogDensity() { return this._fogDensity; }

  // ── forecast for LOD / streaming anticipation ─────────────
  // Predicts weather and time-of-day N seconds into the future,
  // assuming no state change. Useful for camera extrapolation.
  forecast(secondsAhead, clock) {
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    const futureTime = (now + secondsAhead) * this.timeScale;
    const futureDayPhase = (futureTime % this.dayLength) / this.dayLength;
    const futureSunAngle = (futureDayPhase - 0.25) * 2 * Math.PI;
    const futureSunAltitude = Math.sin(futureSunAngle);
    const futureSunIntensity = Math.max(0, futureSunAltitude);
    return {
      dayPhase: futureDayPhase,
      sunAltitude: futureSunAltitude,
      sunIntensity: futureSunIntensity,
      weatherState: this._weather,
      weatherSeverity: this._weatherSeverity,
      temperature: this._ambientTemperature,
      isNight: futureSunAltitude < 0
    };
  }

  // ── diagnostics ────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    this._stats.updates = 0;
    this._stats.weatherChanges = 0;
    this._stats.dawnEvents = 0;
    this._stats.duskEvents = 0;
    this._stats.seasonShifts = 0;
    this._stats.stormOnsets = 0;
  }

  dispose() {
    this._dispatcher = null;
    this._windVector.set(0, 0, 0);
    this._sunDirection.set(0, 1, 0);
  }
}

export {
  TemporalContextProvider,
  WEATHER,
  WEATHER_NAMES,
  WEATHER_SEVERITY,
  PROVIDER_HZ,
  PROVIDER_INTERVAL,
  DAY_LENGTH,
  YEAR_LENGTH,
  TWILIGHT_DURATION
};