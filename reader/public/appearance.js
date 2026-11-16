/**
 * appearance.js — the three built-in light appearances, and one local
 * preference.
 *
 * The presets are colour-token overrides in `styles.css`; this module only
 * validates an id, puts it on the root element as `data-appearance`, and
 * remembers it in `localStorage`. Nothing here touches IndexedDB, the demo
 * store or the network, and a browser that refuses `localStorage` keeps the
 * in-memory choice for the rest of the visit instead of failing.
 *
 * `index.html` repeats the storage key and the three ids in a tiny synchronous
 * script so the saved preset is applied before first paint. `tests/site.test.mjs`
 * keeps the two in step.
 */

/** The single browser-local key. One preference, one value. */
export const APPEARANCE_KEY = 'vitruvian.appearance';

/** The attribute `styles.css` keys its token overrides off. */
export const APPEARANCE_ATTRIBUTE = 'data-appearance';

/** Clear is the default: plain white surfaces with blue accents. */
export const APPEARANCE_DEFAULT = 'clear';

export const APPEARANCES = Object.freeze([
  Object.freeze({
    id: 'clear',
    label: 'Clear',
    description: 'White surfaces, charcoal text and blue links.',
  }),
  Object.freeze({
    id: 'paper',
    label: 'Paper',
    description: 'Warm off-white surfaces with the same blue links.',
  }),
  Object.freeze({
    id: 'lilac',
    label: 'Soft Lilac',
    description: 'Neutral light surfaces with restrained violet accents.',
  }),
]);

const APPEARANCE_IDS = Object.freeze(APPEARANCES.map((preset) => preset.id));

/** The choice made in this session, which survives a refused `localStorage`. */
let current = APPEARANCE_DEFAULT;

export function isAppearanceId(value) {
  return APPEARANCE_IDS.includes(String(value ?? ''));
}

/** Anything that is not one of the three known ids is the default. */
export function normalizeAppearanceId(value) {
  return isAppearanceId(value) ? String(value) : APPEARANCE_DEFAULT;
}

export function appearanceLabel(id) {
  const preset = APPEARANCES.find((entry) => entry.id === normalizeAppearanceId(id));
  return preset ? preset.label : APPEARANCES[0].label;
}

/**
 * `localStorage` can throw on *access*, not just on write (blocked cookies, a
 * sandboxed frame), so even reading the property is guarded.
 */
export function safeStorage(scope = globalThis) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A stored value is untrusted: only an exact known id is honoured. */
export function readStoredAppearance(storage = safeStorage()) {
  try {
    return normalizeAppearanceId(storage?.getItem?.(APPEARANCE_KEY));
  } catch {
    return APPEARANCE_DEFAULT;
  }
}

/** Returns whether the preference was actually persisted. */
export function writeStoredAppearance(id, storage = safeStorage()) {
  if (!isAppearanceId(id)) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(APPEARANCE_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}

/** Put the preset on the root element and remember it for this session. */
export function applyAppearance(id, root = globalThis.document?.documentElement) {
  current = normalizeAppearanceId(id);
  try {
    root?.setAttribute?.(APPEARANCE_ATTRIBUTE, current);
  } catch {
    /* a root that refuses attributes still leaves the in-memory choice */
  }
  return current;
}

export function currentAppearance() {
  return current;
}

/** Apply the saved preference. Idempotent with the inline script in the shell. */
export function initAppearance(root = globalThis.document?.documentElement, storage = safeStorage()) {
  return applyAppearance(readStoredAppearance(storage), root);
}

/**
 * Choose a preset. The appearance always changes; the returned `stored` says
 * whether this browser will remember it, so the caller can say so plainly.
 */
export function setAppearance(
  id,
  { root = globalThis.document?.documentElement, storage = safeStorage() } = {},
) {
  const applied = applyAppearance(id, root);
  const stored = writeStoredAppearance(applied, storage);
  return { id: applied, stored };
}
