/**
 * demo-tracking.js — active reading time and distinct pages, measured locally.
 *
 * The rules are separate from the wiring so they can be reasoned about (and
 * tested) without a browser:
 *
 *  - only the signed-in reader is measured;
 *  - only a note that actually rendered counts, so a failed load is not a page;
 *  - the note must be the pane the reader is looking at, so a hover preview and
 *    a rebuilt pane behind the front one are not new pages;
 *  - time accrues only while the tab is visible, the reader is not idle, and no
 *    demo dialog is open;
 *  - time is accumulated in bounded steps, so a suspended tab or a throttled
 *    timer cannot bill the reader for hours they did not spend.
 */
import { isDemoPaneId } from './demo-model.js';

export const READING_DEFAULTS = Object.freeze({
  /** No pointer, key or scroll for this long means the reader walked away. */
  idleMs: 90_000,
  /** Largest single step added to the clock, however long the gap was. */
  maxStepMs: 30_000,
  /** How much measured time to hold before handing it to the store. */
  flushMs: 20_000,
  /** How often the tracker re-evaluates and rolls the clock forward. */
  tickMs: 5_000,
});

/** A demo, account or admin pane is a view, never a page of the vault. */
function isMeasurableNote(id) {
  return Boolean(id) && !isDemoPaneId(id);
}

/** A page view is one distinct note, seen, by a signed-in reader. */
export function shouldCountView({ signedIn, activeNoteId, isRendered, paused }) {
  return Boolean(signedIn && !paused && isMeasurableNote(activeNoteId) && isRendered);
}

/** Time accrues under the same conditions plus visibility and non-idleness. */
export function shouldCountTime({ signedIn, activeNoteId, isRendered, visible, idle, paused }) {
  return Boolean(signedIn && !paused && visible && !idle && isMeasurableNote(activeNoteId) && isRendered);
}

export function createReadingTracker(options = {}) {
  const {
    now = () => Date.now(),
    setInterval: schedule = (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: cancel = (id) => globalThis.clearInterval(id),
    onView = () => {},
    onTime = () => {},
    onActivityChange = () => {},
    idleMs = READING_DEFAULTS.idleMs,
    maxStepMs = READING_DEFAULTS.maxStepMs,
    flushMs = READING_DEFAULTS.flushMs,
    tickMs = READING_DEFAULTS.tickMs,
  } = options;

  const rendered = new Set();
  let signedIn = false;
  let visible = true;
  let paused = false;
  let activeNoteId = null;
  let countedNoteId = null;
  let lastInteractionAt = now();
  /** When the current measured stretch began, or null while not measuring. */
  let stretchAt = null;
  let pendingMs = 0;
  let counting = false;
  let timer = 0;

  function isIdle(at) {
    return at - lastInteractionAt >= idleMs;
  }

  /** Move measured time forward to `at`, never by more than one bounded step. */
  function roll(at) {
    if (stretchAt === null) return;
    const step = Math.min(Math.max(0, at - stretchAt), maxStepMs);
    if (step > 0) pendingMs += step;
    stretchAt = at;
  }

  function stopStretch(at) {
    roll(at);
    stretchAt = null;
  }

  function evaluate(at = now()) {
    const isRendered = isMeasurableNote(activeNoteId) && rendered.has(activeNoteId);
    const countingNow = shouldCountTime({
      signedIn, activeNoteId, isRendered, visible, idle: isIdle(at), paused,
    });

    if (countingNow) {
      if (stretchAt === null) stretchAt = at;
      else roll(at);
    } else {
      stopStretch(at);
    }

    if (shouldCountView({ signedIn, activeNoteId, isRendered, paused }) && activeNoteId !== countedNoteId) {
      countedNoteId = activeNoteId;
      onView(activeNoteId);
    }
    // Leaving the notes entirely (a demo pane, an empty stack) ends the visit,
    // so coming back to the same note counts as a new one.
    if (!isMeasurableNote(activeNoteId)) countedNoteId = null;

    if (countingNow !== counting) {
      counting = countingNow;
      onActivityChange(counting);
    }
    return counting;
  }

  /** Hand measured time to the caller. Returns what was handed over. */
  function flush() {
    if (pendingMs <= 0) return 0;
    const measured = pendingMs;
    pendingMs = 0;
    if (signedIn) onTime(measured);
    return measured;
  }

  function tick(at = now()) {
    evaluate(at);
    if (pendingMs >= flushMs) flush();
  }

  return {
    setSignedIn(value) {
      const next = Boolean(value);
      if (next === signedIn) return;
      evaluate();
      // Signing out must not lose the time already measured for that reader.
      if (!next) flush();
      signedIn = next;
      if (!next) {
        countedNoteId = null;
        stretchAt = null;
        counting = false;
      }
      evaluate();
    },
    setVisible(value) {
      visible = Boolean(value);
      evaluate();
    },
    setPaused(value) {
      paused = Boolean(value);
      evaluate();
    },
    setActiveNote(id) {
      const next = id ?? null;
      if (next === activeNoteId) return;
      evaluate();
      // Leaving a measured note ends that visit. Hand over whatever short
      // stretch was measured now, so a session below the flush threshold is
      // still persisted before the next view reads the statistics.
      const leavingMeasuredNote = isMeasurableNote(activeNoteId) && !isMeasurableNote(next);
      activeNoteId = next;
      evaluate();
      if (leavingMeasuredNote) flush();
    },
    /** Called after a note has actually rendered into its pane. */
    markRendered(id) {
      if (!id || rendered.has(id)) return;
      rendered.add(id);
      evaluate();
    },
    clearRendered() {
      if (!rendered.size) return;
      rendered.clear();
      evaluate();
    },
    noteInteraction(at = now()) {
      lastInteractionAt = at;
      evaluate(at);
    },
    tick,
    flush,
    /** Roll the current stretch forward, then hand over everything measured. */
    settle(at = now()) {
      evaluate(at);
      return flush();
    },
    /** Drop measured time without writing it, for a reset that discards it. */
    discard() {
      pendingMs = 0;
      stretchAt = null;
      return 0;
    },
    start() {
      if (timer) return;
      timer = schedule(() => tick(), tickMs);
    },
    dispose() {
      if (timer) {
        cancel(timer);
        timer = 0;
      }
      flush();
    },
    snapshot() {
      return {
        signedIn,
        visible,
        paused,
        activeNoteId,
        countedNoteId,
        rendered: [...rendered],
        pendingMs,
        counting,
        idleMs,
        maxStepMs,
      };
    },
  };
}
