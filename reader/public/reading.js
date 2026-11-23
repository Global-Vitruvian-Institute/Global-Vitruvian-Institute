/**
 * reading.js — how a note opens.
 *
 * `page` is the default: one note at a time, ordinary links, and the browser's
 * own Back. `stacked` is the advanced reader that keeps earlier notes visible
 * to the left. The mode is a browser-local preference; `index.html` repeats the
 * key and both ids so the choice applies before first paint.
 */

export const READING_KEY = 'vitruvian.reading';
export const READING_ATTRIBUTE = 'data-reading';
export const READING_DEFAULT = 'page';

export const READING_MODES = Object.freeze([
  Object.freeze({
    id: 'page',
    label: 'Page',
    description: 'One note at a time, with ordinary links and browser Back.',
  }),
  Object.freeze({
    id: 'stacked',
    label: 'Stacked tabs (advanced)',
    description: 'Keep earlier notes open to the left as a path through the notes.',
  }),
]);

const READING_IDS = Object.freeze(READING_MODES.map((mode) => mode.id));
let current = READING_DEFAULT;

export function isReadingMode(value) {
  return READING_IDS.includes(String(value ?? ''));
}

export function normalizeReadingMode(value) {
  return isReadingMode(value) ? String(value) : READING_DEFAULT;
}

export function readingModeLabel(id) {
  const mode = READING_MODES.find((entry) => entry.id === normalizeReadingMode(id));
  return mode ? mode.label : READING_MODES[0].label;
}

function safeStorage(scope = globalThis) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredReadingMode(storage = safeStorage()) {
  try {
    return normalizeReadingMode(storage?.getItem?.(READING_KEY));
  } catch {
    return READING_DEFAULT;
  }
}

export function writeStoredReadingMode(id, storage = safeStorage()) {
  if (!isReadingMode(id)) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(READING_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}

export function applyReadingMode(id, root = globalThis.document?.documentElement) {
  current = normalizeReadingMode(id);
  try {
    root?.setAttribute?.(READING_ATTRIBUTE, current);
  } catch {
    /* the in-memory choice still applies */
  }
  return current;
}

export function currentReadingMode() {
  return current;
}

export function initReadingMode(root = globalThis.document?.documentElement, storage = safeStorage()) {
  return applyReadingMode(readStoredReadingMode(storage), root);
}

/** Change the mode. The returned `stored` says whether this browser remembers it. */
export function setReadingMode(
  id,
  { root = globalThis.document?.documentElement, storage = safeStorage() } = {},
) {
  const applied = applyReadingMode(id, root);
  const stored = writeStoredReadingMode(applied, storage);
  return { id: applied, stored };
}
