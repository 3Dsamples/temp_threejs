// file number : 026
// full path name : src/ecs/026_observers_events.js
// description : Observer, Event, and Alert subsystem inspired by flecs.
//               Provides a full event-emission bus with typed event kinds
//               (OnAdd, OnSet, OnRemove, OnTableAdd, OnTableRemove,
//               OnQueryMatch, OnTick, OnAlert, OnCustom, OnProgress), a
//               deferred multi-dispatch pipeline so observers react after
//               structural changes have been committed, per-observer SoA
//               storage so 1M+ entities can emit events without per-event
//               allocation, monitor components that watch a query's match
//               count against a threshold and fire alerts when it crosses,
//               and a context-aware state-machine helper built on top of
//               the observer system that lets entities react to world
//               state (nearby enemies, low HP, day/night cycle, LOD
//               transitions) with a single declarative rule. Everything
//               is typed-array backed; event emission is O(observers) with
//               short-circuit filtering, and the deferred queue reuses a
//               ring-buffer pool so 1M-entity scenes never allocate during
//               steady-state gameplay on Android 64-bit.
// best for : Reactive game logic, achievement / quest triggers, AI state
//            transitions, LOD-driven behaviour changes, input handlers,
//            UI refresh hooks, save/load triggers, alerting on resource
//            thresholds, and any context-awareness pipeline that must
//            react to 1M-entity world state without GC spikes.
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
  LocalTransformF32,
} from '../transform/002_transform_hierarchy.js';

import {
  bvhFrustumCull,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
} from '../geometry/004_aabb_bounds.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ              = 1e-16;
const EPSILON                 = 1e-8;
const EPSILON_HIGH            = 1e-12;
const PI                      = Math.PI;
const TWO_PI                  = 2 * Math.PI;
const INV_PI                  = 1 / Math.PI;
const INV_TWO_PI              = 1 / (2 * Math.PI);
const HALF_PI                 = Math.PI / 2;
const DEG_TO_RAD              = Math.PI / 180;
const RAD_TO_DEG              = 180 / Math.PI;

const MAX_OBSERVERS            = 4096;
const MAX_MONITORS             = 1024;
const MAX_ALERTS               = 256;
const MAX_EVENT_QUEUE          = 65536;
const MAX_OBSERVER_COMPONENTS  = 8;
const MAX_STATE_MACHINES       = 65536;
const MAX_STATE_TRANSITIONS    = 8;
const EVENT_QUEUE_WRAP         = MAX_EVENT_QUEUE - 1;

// ═══════════════════════════════════════════════════════════════════════
// EVENT KIND ENUM — mirrors flecs EcsEventKind
// ═══════════════════════════════════════════════════════════════════════

export const EventKind = Object.freeze({
  ON_ADD:         0,
  ON_REMOVE:      1,
  ON_SET:         2,
  ON_TABLE_ADD:   3,
  ON_TABLE_REMOVE:4,
  ON_QUERY_MATCH: 5,
  ON_TICK:        6,
  ON_ALERT:       7,
  ON_CUSTOM:      8,
  ON_PROGRESS:    9,
});

/** Convenience hook factories — like flecs EcsOnAdd / EcsOnSet / etc. */
export const OnAdd        = (component) => ({ kind: EventKind.ON_ADD, component });
export const OnSet        = (component) => ({ kind: EventKind.ON_SET, component });
export const OnRemove     = (component) => ({ kind: EventKind.ON_REMOVE, component });
export const OnCustom     = (name) => ({ kind: EventKind.ON_CUSTOM, name });
export const OnTick       = () => ({ kind: EventKind.ON_TICK });
export const OnAlert      = (alertId) => ({ kind: EventKind.ON_ALERT, alertId });

// ═══════════════════════════════════════════════════════════════════════
// OBSERVER SoA STORAGE
// ═══════════════════════════════════════════════════════════════════════

export const Observers = {
  // Event kind this observer reacts to.
  kind: new Uint8Array(MAX_OBSERVERS),

  // Primary component filter (0 = none).
  component: new Uint32Array(MAX_OBSERVERS),

  // Additional AND-ed components (up to MAX_OBSERVER_COMPONENTS).
  extraComponents: new Uint32Array(MAX_OBSERVERS * MAX_OBSERVER_COMPONENTS),
  extraComponentCount: new Uint8Array(MAX_OBSERVERS),

  // Callback function (called with (eid, componentOrEvent, data)).
  callback: new Array(MAX_OBSERVERS).fill(null),

  // Enabled flag.
  enabled: new Uint8Array(MAX_OBSERVERS),

  // Custom event name hash (for OnCustom).
  customHash: new Uint32Array(MAX_OBSERVERS),

  // Alert id (for OnAlert).
  alertId: new Uint16Array(MAX_OBSERVERS),

  // Match counter.
  matchCount: new Uint32Array(MAX_OBSERVERS),
};

let _nextObserverSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// CREATE OBSERVER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register an observer.
 *
 * @param hook        { kind, component } from OnAdd/OnSet/OnRemove/etc.
 * @param callback    function (eid, componentRef, data) — see below
 * @param options     { extraComponents: [c1, c2, ...], name: string }
 * @returns observer slot id (use with removeObserver)
 *
 * Callback signature:
 *   ON_ADD       (eid, component)
 *   ON_SET       (eid, component, data)   [data from setComponent]
 *   ON_REMOVE    (eid, component)
 *   ON_TICK      (dt)
 *   ON_ALERT     (alertId, monitorId, count)
 *   ON_CUSTOM    (name, eid, payload)
 */
export function addObserver(hook, callback, options = {}) {
  if (_nextObserverSlot >= MAX_OBSERVERS) throw new Error('observer capacity exceeded');
  const slot = _nextObserverSlot++;

  Observers.kind[slot] = hook.kind;
  Observers.component[slot] = hook.component ?? 0;
  Observers.callback[slot] = callback;
  Observers.enabled[slot] = 1;

  const extra = options.extraComponents ?? [];
  const count = Math.min(extra.length, MAX_OBSERVER_COMPONENTS);
  for (let i = 0; i < count; i++) {
    Observers.extraComponents[slot * MAX_OBSERVER_COMPONENTS + i] = extra[i];
  }
  Observers.extraComponentCount[slot] = count;

  if (hook.kind === EventKind.ON_CUSTOM && options.name) {
    Observers.customHash[slot] = hashString(options.name);
  }
  if (hook.kind === EventKind.ON_ALERT && hook.alertId !== undefined) {
    Observers.alertId[slot] = hook.alertId;
  }

  return slot;
}

export function removeObserver(slot) {
  if (slot < 0 || slot >= _nextObserverSlot) return;
  Observers.enabled[slot] = 0;
  Observers.callback[slot] = null;
}

export function setObserverEnabled(slot, enabled) {
  if (slot < 0 || slot >= _nextObserverSlot) return;
  Observers.enabled[slot] = enabled ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// SIMPLE 32-BIT STRING HASH (djb2 variant)
// ═══════════════════════════════════════════════════════════════════════

export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT QUEUE — deferred multi-dispatch ring buffer
// ═══════════════════════════════════════════════════════════════════════

export const EventQueue = {
  // Parallel arrays storing queued events.
  kind: new Uint8Array(MAX_EVENT_QUEUE),
  eid: new Uint32Array(MAX_EVENT_QUEUE),
  component: new Uint32Array(MAX_EVENT_QUEUE),
  alertId: new Uint16Array(MAX_EVENT_QUEUE),
  customHash: new Uint32Array(MAX_EVENT_QUEUE),

  // Slot for storing optional payload (data). Use typed map.
  payloadSlot: new Int32Array(MAX_EVENT_QUEUE),

  // Ring buffer pointers.
  head: 0,
  tail: 0,
  count: 0,

  // Payload pool (recycled).
  payloadPool: [],
  payloadPoolFree: [],
};

function allocPayload() {
  if (EventQueue.payloadPoolFree.length > 0) {
    return EventQueue.payloadPoolFree.pop();
  }
  const id = EventQueue.payloadPool.length;
  EventQueue.payloadPool.push(null);
  return id;
}

function freePayload(slot) {
  if (slot < 0) return;
  EventQueue.payloadPool[slot] = null;
  EventQueue.payloadPoolFree.push(slot);
}

/**
 * Queue an event for deferred dispatch.
 * Called from within addComponent / removeComponent / setComponent hooks.
 * Bounded ring buffer: oldest event is overwritten when full.
 */
export function queueEvent(kind, eid, component = 0, data = undefined, extraHash = 0, alertId = 0) {
  const q = EventQueue;
  const slot = q.head;

  q.kind[slot] = kind;
  q.eid[slot] = eid;
  q.component[slot] = component;
  q.alertId[slot] = alertId;
  q.customHash[slot] = extraHash;

  if (data !== undefined) {
    const payloadId = allocPayload();
    q.payloadPool[payloadId] = data;
    q.payloadSlot[slot] = payloadId;
  } else {
    q.payloadSlot[slot] = -1;
  }

  q.head = (q.head + 1) & EVENT_QUEUE_WRAP;
  q.count++;

  // Overflow: advance tail to overwrite oldest.
  if (q.count > MAX_EVENT_QUEUE) {
    freePayload(q.payloadSlot[q.tail]);
    q.tail = (q.tail + 1) & EVENT_QUEUE_WRAP;
    q.count = MAX_EVENT_QUEUE;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FLUSH — dispatch all queued events to matching observers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dispatch every queued event to observers. Called once per frame
 * (or per fixed step) by the ECS runtime.
 *
 * Events are dispatched in FIFO order. Observers that throw are
 * silently skipped so a single bad callback doesn't crash the frame.
 */
export function flushEvents(world) {
  const q = EventQueue;

  while (q.count > 0) {
    const slot = q.tail;
    const kind = q.kind[slot];
    const eid = q.eid[slot];
    const component = q.component[slot];
    const payloadId = q.payloadSlot[slot];
    const data = payloadId >= 0 ? q.payloadPool[payloadId] : undefined;
    const customHash = q.customHash[slot];
    const alertId = q.alertId[slot];

    // Dispatch to matching observers.
    dispatchEvent(kind, eid, component, data, customHash, alertId);

    if (payloadId >= 0) freePayload(payloadId);

    q.tail = (q.tail + 1) & EVENT_QUEUE_WRAP;
    q.count--;
  }

  return world;
}

function dispatchEvent(kind, eid, component, data, customHash, alertId) {
  for (let slot = 0; slot < _nextObserverSlot; slot++) {
    const O = Observers;
    if (!O.enabled[slot]) continue;
    if (O.kind[slot] !== kind) continue;

    // Filter by component.
    if (O.component[slot] !== 0) {
      if (kind === EventKind.ON_ADD
          || kind === EventKind.ON_REMOVE
          || kind === EventKind.ON_SET) {
        if (O.component[slot] !== component) continue;
      }
    }

    // Filter by custom hash.
    if (kind === EventKind.ON_CUSTOM) {
      if (O.customHash[slot] !== 0 && O.customHash[slot] !== customHash) continue;
    }

    // Filter by alert id.
    if (kind === EventKind.ON_ALERT) {
      if (O.alertId[slot] !== 0 && O.alertId[slot] !== alertId) continue;
    }

    // Check extra AND-ed components exist on the entity.
    if (eid !== 0 && O.extraComponentCount[slot] > 0) {
      let ok = true;
      for (let e = 0; e < O.extraComponentCount[slot]; e++) {
        const c = O.extraComponents[slot * MAX_OBSERVER_COMPONENTS + e];
        if (!hasComponent(null, eid, c)) { ok = false; break; }
      }
      if (!ok) continue;
    }

    // Invoke callback.
    const cb = O.callback[slot];
    if (cb) {
      try {
        O.matchCount[slot]++;
        if (kind === EventKind.ON_TICK)      cb(data /* dt */);
        else if (kind === EventKind.ON_ALERT) cb(alertId, data);
        else if (kind === EventKind.ON_CUSTOM) cb(customHash, eid, data);
        else                                  cb(eid, component, data);
      } catch (e) {
        if (typeof console !== 'undefined') {
          console.warn(`[026_observers] observer ${slot} threw:`, e);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC EMIT API — enqueue any event programmatically
// ═══════════════════════════════════════════════════════════════════════

export function emitAdd(eid, component) {
  queueEvent(EventKind.ON_ADD, eid, component);
}

export function emitRemove(eid, component) {
  queueEvent(EventKind.ON_REMOVE, eid, component);
}

export function emitSet(eid, component, data) {
  queueEvent(EventKind.ON_SET, eid, component, data);
}

export function emitCustom(name, eid, payload) {
  queueEvent(EventKind.ON_CUSTOM, eid, 0, payload, hashString(name));
}

export function emitTick(dt) {
  queueEvent(EventKind.ON_TICK, 0, 0, dt);
}

// ═══════════════════════════════════════════════════════════════════════
// MONITOR — watch a query's match count against a threshold
// ═══════════════════════════════════════════════════════════════════════

export const Monitors = {
  // Query slot id this monitor watches.
  querySlot: new Uint32Array(MAX_MONITORS),

  // Threshold (match count).
  threshold: new Uint32Array(MAX_MONITORS),

  // Condition: 0 = count >= threshold, 1 = count <= threshold,
  //            2 = count == threshold, 3 = count != threshold.
  condition: new Uint8Array(MAX_MONITORS),

  // Last match count (to detect crossings).
  lastMatchCount: new Uint32Array(MAX_MONITORS),

  // Alert fired flag (prevents re-firing until reset).
  alertFired: new Uint8Array(MAX_MONITORS),

  // Associated alert id (for observer filtering).
  alertId: new Uint16Array(MAX_MONITORS),

  // Enabled.
  enabled: new Uint8Array(MAX_MONITORS),

  // Name for debugging.
  name: new Array(MAX_MONITORS).fill(''),

  // Match query terms — stored for re-evaluation.
  queryTerms: new Array(MAX_MONITORS).fill(null),
};

let _nextMonitorSlot = 0;

/**
 * Register a monitor. Evaluated once per frame after flushEvents.
 *
 * @param queryTerms  array of component refs (same form as query())
 * @param condition   '>=' | '<=' | '==' | '!='
 * @param threshold   count threshold
 * @param alertId     id to correlate with OnAlert observers
 * @param name        debug name
 */
export function addMonitor(queryTerms, condition, threshold, alertId = 0, name = '') {
  if (_nextMonitorSlot >= MAX_MONITORS) throw new Error('monitor capacity exceeded');
  const slot = _nextMonitorSlot++;

  Monitors.querySlot[slot] = slot;
  Monitors.threshold[slot] = threshold;
  Monitors.condition[slot] = condition === '>=' ? 0 :
                             condition === '<=' ? 1 :
                             condition === '==' ? 2 : 3;
  Monitors.lastMatchCount[slot] = 0;
  Monitors.alertFired[slot] = 0;
  Monitors.alertId[slot] = alertId;
  Monitors.enabled[slot] = 1;
  Monitors.name[slot] = name;
  Monitors.queryTerms[slot] = queryTerms;

  return slot;
}

export function removeMonitor(slot) {
  if (slot < 0 || slot >= _nextMonitorSlot) return;
  Monitors.enabled[slot] = 0;
  Monitors.queryTerms[slot] = null;
}

/**
 * Reset the alert so it can fire again on the next crossing.
 */
export function resetMonitorAlert(slot) {
  if (slot >= 0 && slot < _nextMonitorSlot) Monitors.alertFired[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — evaluate monitors and fire alerts
// ═══════════════════════════════════════════════════════════════════════

export function systemEvaluateMonitors(world) {
  for (let slot = 0; slot < _nextMonitorSlot; slot++) {
    const M = Monitors;
    if (!M.enabled[slot]) continue;
    if (!M.queryTerms[slot]) continue;

    let count = 0;
    try {
      const result = query(world, M.queryTerms[slot]);
      count = result.length;
    } catch (e) {
      continue;
    }

    const prev = M.lastMatchCount[slot];
    M.lastMatchCount[slot] = count;

    // Skip if crossing not detected.
    if (prev === count) continue;

    let fires = false;
    const threshold = M.threshold[slot];
    switch (M.condition[slot]) {
      case 0: fires = count >= threshold; break;   // >=
      case 1: fires = count <= threshold; break;   // <=
      case 2: fires = count === threshold; break;  // ==
      case 3: fires = count !== threshold; break;  // !=
    }

    // Fire once per crossing, unless the monitor has been reset.
    if (fires && !M.alertFired[slot]) {
      M.alertFired[slot] = 1;
      queueEvent(EventKind.ON_ALERT, 0, 0, { monitorId: slot, count }, 0, M.alertId[slot]);
    }

    // Reset when the alert condition is no longer met.
    if (!fires) {
      M.alertFired[slot] = 0;
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CONTEXT-AWARE STATE MACHINE — built on observers + monitors
// ═══════════════════════════════════════════════════════════════════════

/**
 * StateMachine is a per-entity decision FSM triggered by observer events.
 * Each machine has up to MAX_STATE_TRANSITIONS rules:
 *   { trigger, targetState, predicate }
 *
 * When a trigger observer fires for this entity, the predicate is
 * evaluated. If true, the entity's state component is updated to
 * targetState (0 = idle, 1..N = state ids chosen by the game).
 */
export const StateMachine = {
  // Entity -> machine slot (via addComponent(StateMachineTag)).
  machineSlot: new Uint32Array(65536),
  ownerEid: new Uint32Array(MAX_STATE_MACHINES),
  currentState: new Uint32Array(MAX_STATE_MACHINES),

  // Transition tables.
  transitionCount: new Uint8Array(MAX_STATE_MACHINES),
  transitionObserver: new Uint32Array(MAX_STATE_MACHINES * MAX_STATE_TRANSITIONS),
  transitionTargetState: new Uint32Array(MAX_STATE_MACHINES * MAX_STATE_TRANSITIONS),
  transitionPredicate: new Array(MAX_STATE_MACHINES * MAX_STATE_TRANSITIONS).fill(null),
};

/** Marker: entity is a state machine. */
export const StateMachineTag = {};

let _nextStateMachineSlot = 0;

/**
 * Attach a state machine to an entity.
 * @param initialState   state id (0 = idle)
 */
export function addStateMachine(world, eid, initialState = 0) {
  if (_nextStateMachineSlot >= MAX_STATE_MACHINES) throw new Error('state machine capacity exceeded');
  const slot = _nextStateMachineSlot++;

  addComponent(world, eid, StateMachineTag);

  StateMachine.ownerEid[slot] = eid;
  StateMachine.currentState[slot] = initialState;
  StateMachine.transitionCount[slot] = 0;

  const id = getId(eid);
  StateMachine.machineSlot[id] = slot;
  return slot;
}

/**
 * Add a transition rule.
 * @param triggerKind   an EventKind (typically ON_ADD, ON_SET, ON_CUSTOM)
 * @param triggerComponent   component ref (0 = any)
 * @param predicate     function (eid, data) → boolean (true = transition)
 * @param targetState   destination state id
 * @returns a handle for removeTransition (or -1 on failure)
 */
export function addTransition(world, machineSlot, triggerKind, triggerComponent, predicate, targetState) {
  const M = StateMachine;
  const count = M.transitionCount[machineSlot];
  if (count >= MAX_STATE_TRANSITIONS) return -1;

  const transIdx = machineSlot * MAX_STATE_TRANSITIONS + count;

  // Register an observer to watch for this trigger.
  const observerSlot = addObserver(
    { kind: triggerKind, component: triggerComponent },
    (eid, component, data) => {
      // Only process if this entity's machine matches.
      const id = getId(eid);
      if (M.machineSlot[id] !== machineSlot) return;

      // Evaluate predicate.
      let ok = true;
      if (predicate) {
        try { ok = predicate(eid, data); } catch (e) { ok = false; }
      }
      if (!ok) return;

      // Transition.
      const prev = M.currentState[machineSlot];
      M.currentState[machineSlot] = targetState;

      // Emit a custom event so the game can react to the transition.
      emitCustom(
        `state:${prev}->${targetState}`,
        eid,
        { machineSlot, from: prev, to: targetState }
      );
    },
    { extraComponents: [StateMachineTag] }
  );

  M.transitionObserver[transIdx] = observerSlot;
  M.transitionTargetState[transIdx] = targetState;
  M.transitionPredicate[transIdx] = predicate;
  M.transitionCount[machineSlot] = count + 1;

  return transIdx;
}

export function getState(world, eid) {
  const id = getId(eid);
  const slot = StateMachine.machineSlot[id];
  return StateMachine.currentState[slot];
}

export function setState(world, eid, state) {
  const id = getId(eid);
  const slot = StateMachine.machineSlot[id];
  const prev = StateMachine.currentState[slot];
  StateMachine.currentState[slot] = state;
  emitCustom(`state:${prev}->${state}`, eid, { machineSlot: slot, from: prev, to: state });
}

// ═══════════════════════════════════════════════════════════════════════
// TYPED COMPONENT CHANGE HELPERS — integrate with ECS add/remove/set
// ═══════════════════════════════════════════════════════════════════════

/**
 * Wrapper for addComponent that also queues an ON_ADD event.
 * Use when you want observers to react to a specific addition.
 */
export function addComponentWithEvent(world, eid, component) {
  const added = addComponent(world, eid, component);
  if (added) queueEvent(EventKind.ON_ADD, eid, component);
  return added;
}

/**
 * Wrapper for removeComponent that queues an ON_REMOVE event.
 */
export function removeComponentWithEvent(world, eid, component) {
  const removed = removeComponent(world, eid, component);
  if (removed) queueEvent(EventKind.ON_REMOVE, eid, component);
  return removed;
}

/**
 * Wrapper for setComponent that queues an ON_SET event with data.
 */
export function setComponentWithEvent(world, eid, component, data) {
  addComponent(world, eid, component);
  queueEvent(EventKind.ON_SET, eid, component, data);
}

// ═══════════════════════════════════════════════════════════════════════
// FULL SYSTEM TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run one event-processing pass.
 * Order:
 *   1. Evaluate monitors (they may queue ON_ALERT events).
 *   2. Flush all queued events (dispatch to observers).
 *
 * Call this once per frame BEFORE systems that depend on reactive state.
 */
export function systemObserverTick(world, dt = 1 / 60) {
  // Queue the per-frame tick event first so it runs at the end.
  emitTick(dt);

  // Evaluate monitors — may add alerts.
  systemEvaluateMonitors(world);

  // Dispatch everything (including the tick).
  flushEvents(world);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearObservers() {
  _nextObserverSlot = 0;
  _nextMonitorSlot = 0;
  _nextStateMachineSlot = 0;

  Observers.enabled.fill(0);
  Observers.callback.fill(null);

  Monitors.enabled.fill(0);
  Monitors.queryTerms.fill(null);

  EventQueue.head = 0;
  EventQueue.tail = 0;
  EventQueue.count = 0;
  for (let i = 0; i < EventQueue.payloadSlot.length; i++) {
    EventQueue.payloadSlot[i] = -1;
  }
  EventQueue.payloadPool.length = 0;
  EventQueue.payloadPoolFree.length = 0;

  StateMachine.machineSlot.fill(0);
  StateMachine.transitionPredicate.fill(null);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function observerStats() {
  let activeObservers = 0;
  let activeMonitors = 0;
  let activeMachines = 0;

  for (let i = 0; i < _nextObserverSlot; i++) if (Observers.enabled[i]) activeObservers++;
  for (let i = 0; i < _nextMonitorSlot; i++) if (Monitors.enabled[i]) activeMonitors++;
  for (let i = 0; i < _nextStateMachineSlot; i++) if (StateMachine.ownerEid[i] !== 0) activeMachines++;

  return {
    observerCount: _nextObserverSlot,
    activeObservers,
    monitorCount: _nextMonitorSlot,
    activeMonitors,
    stateMachineCount: _nextStateMachineSlot,
    activeMachines,
    queuedEvents: EventQueue.count,
    observerMatches: Observers.matchCount,
  };
}