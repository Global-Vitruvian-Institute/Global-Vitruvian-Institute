/**
 * view-route.js — the reader's URL shape, as pure functions.
 *
 * The reader is one static page with two kinds of region:
 *
 *   ?note=Breath&stackedNotes=Movement                  the reading stack
 *   ?note=Breath&stackedNotes=Movement&view=account     the full-page account region
 *   ?note=Breath&stackedNotes=Movement&view=settings
 *   ?note=Breath&stackedNotes=Movement&view=admin
 *
 * The reading query parameters and the hash always survive a region change:
 * `view` is the only parameter this module adds or removes, so "Return to notes"
 * is exactly the removal of one key and Back/Forward describe regions.
 *
 * There is no DOM, no `history` and no fetch here. The caller owns `location`
 * and `replaceState`, which is what makes the rules testable on their own.
 */

export const NOTE_PARAM = 'note';
export const STACK_PARAM = 'stackedNotes';
export const VIEW_PARAM = 'view';

export const VIEW_READER = 'reader';
export const VIEW_ACCOUNT = 'account';
export const VIEW_SETTINGS = 'settings';
export const VIEW_ADMIN = 'admin';

export const VIEW_IDS = Object.freeze([VIEW_READER, VIEW_ACCOUNT, VIEW_SETTINGS, VIEW_ADMIN]);
export const ACCOUNT_VIEW_IDS = Object.freeze([VIEW_ACCOUNT, VIEW_SETTINGS, VIEW_ADMIN]);

/**
 * Reserved pane ids from the previous design, when the account and admin views
 * were panes inside the stack. They are still *read* out of old URLs and
 * migrated to the matching full-page region, but they are never written back and
 * can never open as a reader pane again.
 */
export const LEGACY_VIEW_IDS = Object.freeze({
  'demo:account': VIEW_ACCOUNT,
  'demo:admin': VIEW_ADMIN,
});

/** Unknown and missing values are the reader; there is no dark or automatic mode. */
export function normalizeView(value) {
  const candidate = String(value ?? '').trim().toLowerCase();
  return ACCOUNT_VIEW_IDS.includes(candidate) ? candidate : VIEW_READER;
}

export function isAccountView(view) {
  return ACCOUNT_VIEW_IDS.includes(view);
}

export function isLegacyViewId(id) {
  return Object.hasOwn(LEGACY_VIEW_IDS, id);
}

function stripHash(hash) {
  return String(hash ?? '').replace(/^#/, '');
}

/**
 * Parse the reader's own query string.
 *
 * Returns:
 *   ids      the note ids named by `note` and `stackedNotes`, in order, with
 *            reserved legacy ids removed
 *   view     the validated region (`reader` for anything unknown)
 *   legacy   the region a reserved id selected, or null
 *   hash     the fragment, without its `#`
 *   named    true when the URL named a note at all
 *   changed  true when the URL is not in canonical form — an unknown or
 *            redundant `view`, or a reserved id — so the caller should rewrite
 *            it with `replaceState` (never `pushState`: nothing navigated)
 */
export function parseViewRoute(search = '', hash = '') {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  const note = params.get(NOTE_PARAM);
  const named = note !== null;
  const candidates = named ? [note, ...params.getAll(STACK_PARAM)] : [];

  const ids = [];
  let legacy = null;
  for (const id of candidates) {
    if (isLegacyViewId(id)) {
      // The last reserved id is the frontmost pane, which is the one on screen.
      legacy = LEGACY_VIEW_IDS[id];
      continue;
    }
    ids.push(id);
  }

  const rawView = params.get(VIEW_PARAM);
  const view = legacy ?? normalizeView(rawView);
  // Canonical means the value the URL already carries is the exact id we would
  // write back: a known region, or nothing at all for the reader.
  const canonical = view === VIEW_READER
    ? rawView === null || rawView === VIEW_READER
    : rawView === view;
  // A log destination is separate from the reader's heading fragment, so
  // opening the log never overwrites the place the reader will return to.
  const rawSection = params.get('section');
  const section = view === VIEW_ACCOUNT && rawSection === 'activity-history' ? rawSection : null;
  const changed = Boolean(legacy) || !canonical || (rawSection !== null && rawSection !== section);

  return { ids, view, legacy, hash: stripHash(hash), section, named, changed };
}

/**
 * Serialise a region and its reading stack as a query string relative to the
 * current page — `?note=…&stackedNotes=…&view=…`, plus the hash.
 *
 * `view=reader` is the *absence* of the parameter, so a reading stack has
 * exactly one URL however it was reached.
 */
export function buildRouteQuery({ ids = [], view = VIEW_READER, hash = '', section = null } = {}) {
  const [first, ...rest] = [...ids];
  const params = new URLSearchParams();
  if (first) params.set(NOTE_PARAM, first);
  for (const id of rest) params.append(STACK_PARAM, id);
  if (isAccountView(view)) params.set(VIEW_PARAM, view);
  if (view === VIEW_ACCOUNT && section === 'activity-history') params.set('section', section);
  const query = params.toString();
  const fragment = hash ? `#${stripHash(hash)}` : '';
  return `${query ? `?${query}` : ''}${fragment}`;
}
