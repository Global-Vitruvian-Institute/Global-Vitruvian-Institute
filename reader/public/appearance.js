/**
 * appearance.js — the built-in light stylesheet templates, and one local
 * preference.
 *
 * Each template is a real CSS file under `themes/`. The module validates an id,
 * puts it on the root element as `data-appearance`, swaps the stylesheet link
 * and remembers the choice in `localStorage`. Nothing here touches IndexedDB,
 * the demo store or the network, and a browser that refuses `localStorage`
 * keeps the in-memory choice for the rest of the visit instead of failing.
 *
 * The three Obsidian-inspired palettes adapt only colour tokens from MIT-licensed
 * themes: Minimal, Things and Blue Topaz. Their source comments carry the URL.
 *
 * `index.html` repeats the storage key and the ids in a tiny synchronous script
 * so the saved template is applied before first paint. `tests/site.test.mjs`
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
  Object.freeze({
    id: 'minimal',
    label: 'Minimal',
    description: 'Adapted from the Minimal Obsidian theme: white, grey and quiet type.',
  }),
  Object.freeze({
    id: 'things',
    label: 'Things',
    description: 'Adapted from the Things Obsidian theme: white surfaces and a brighter blue.',
  }),
  Object.freeze({
    id: 'blue-topaz',
    label: 'Blue Topaz',
    description: 'Adapted from Blue Topaz: crisp white surfaces and saturated blue links.',
  }),
  Object.freeze({
    id: 'dark',
    label: 'Dark (dark mode)',
    description: 'Charcoal surfaces, warm off-white text and soft blue links.',
  }),
  Object.freeze({
    id: 'khan',
    label: 'Academy (light)',
    description: 'Bright white and high-clarity blue, after Khan Academy reading colours.',
  }),
  Object.freeze({
    id: 'editorial',
    label: 'Editorial (serif)',
    description: 'Cream paper, oxblood links and a serif reading face.',
  }),
]);

export const APPEARANCE_ATTRIBUTE_LINK = 'theme-stylesheet';

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

/** Point the template stylesheet at the chosen id, when there is a document. */
export function applyThemeStylesheet(id, scope = globalThis) {
  try {
    const link = scope?.document?.getElementById?.(APPEARANCE_ATTRIBUTE_LINK);
    if (!link) return false;
    link.href = `./themes/${normalizeAppearanceId(id)}.css`;
    return true;
  } catch {
    return false;
  }
}

/** Put the template on the root element and remember it for this session. */
export function applyAppearance(id, root = globalThis.document?.documentElement, scope = globalThis) {
  current = normalizeAppearanceId(id);
  try {
    root?.setAttribute?.(APPEARANCE_ATTRIBUTE, current);
  } catch {
    /* a root that refuses attributes still leaves the in-memory choice */
  }
  applyThemeStylesheet(current, scope);
  return current;
}

export function currentAppearance() {
  return current;
}

/** Apply the saved preference. Idempotent with the inline script in the shell. */
export function initAppearance(
  root = globalThis.document?.documentElement,
  storage = safeStorage(),
  scope = globalThis,
) {
  return applyAppearance(readStoredAppearance(storage), root, scope);
}

/**
 * Choose a preset. The appearance always changes; the returned `stored` says
 * whether this browser will remember it, so the caller can say so plainly.
 */
export function setAppearance(
  id,
  { root = globalThis.document?.documentElement, storage = safeStorage(), scope = globalThis } = {},
) {
  const applied = applyAppearance(id, root, scope);
  const stored = writeStoredAppearance(applied, storage);
  return { id: applied, stored };
}
