/**
 * Vitruvian Institute — the browser reader.
 *
 * The URL is the state:
 *
 *   /<first-note>?stackedNotes=<second>&stackedNotes=<third>
 *   ?note=<first>&stackedNotes=<second>&view=account|settings|admin
 *
 * The path is the leftmost pane; each repeated query parameter is a pane to its
 * right. `view` selects a full-page account region instead of the reading
 * stack — the reading parameters and hash are preserved either way. Everything
 * else (fetched note HTML, backlinks, search, previews) is derived from that
 * stack. Nothing here writes to the vault.
 *
 * No build step and no dependencies: this file is loaded directly as a module.
 */

import { fetchStatic as fetch } from './static-api.js';
import { wikipediaArticle } from './wikipedia.js';
import { designPaneLayout, designContextRequest, designContextHeading } from './design-context.js';
import { loadRuntimeStore } from './store-config.js';
import { createDemoUi } from './demo-ui.js';
import { createReadingTracker } from './demo-tracking.js';
import { demoPaneLabel, isDemoPaneId } from './demo-model.js';
import {
  buildRouteQuery,
  isAccountView,
  parseViewRoute,
  VIEW_ACCOUNT,
  VIEW_ADMIN,
  VIEW_READER,
  VIEW_SETTINGS,
} from './view-route.js';
import { initAppearance } from './appearance.js';
import { currentReadingMode, initReadingMode, setReadingMode } from './reading.js';

/** The page title for each region; the reader's own title is the note's. */
const VIEW_TITLES = Object.freeze({
  [VIEW_ACCOUNT]: 'User info',
  [VIEW_SETTINGS]: 'Settings',
  [VIEW_ADMIN]: 'Admin',
});

const els = {
  title: document.getElementById('app-title'),
  random: document.getElementById('random-button'),
  form: document.getElementById('search-form'),
  input: document.getElementById('search-input'),
  key: document.getElementById('search-key'),
  results: document.getElementById('search-results'),
  stack: document.getElementById('stack'),
  account: document.getElementById('account'),
  accountContent: document.getElementById('account-content'),
  accountBack: document.getElementById('account-back'),
  accountUser: document.getElementById('account-user-link'),
  accountSettings: document.getElementById('account-settings-link'),
  accountAdmin: document.getElementById('account-admin-link'),
  preview: document.getElementById('preview'),
  previewContent: document.getElementById('preview-content'),
  status: document.getElementById('status'),
  settings: document.getElementById('settings-button'),
  login: document.getElementById('login-link'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrowLayout = window.matchMedia('(max-width: 800px)');
const desktopPointer = window.matchMedia('(min-width: 801px) and (hover: hover) and (pointer: fine)');

const state = {
  bootstrap: null,
  /** The notes index failed to load; the account region still works. */
  bootstrapError: null,
  stack: [],
  panes: [],
  /** Which page region is exposed: the reading stack or an account view. */
  view: VIEW_READER,
  /** The reading URL's fragment, so switching regions never drops it. */
  routeHash: '',
  /** The reading row's horizontal position while an account view is showing. */
  stackScrollLeft: 0,
  ready: false,
  previewEnabled: false,
};

/** Successful note responses are immutable for the life of the server process. */
const noteCache = new Map();

/**
 * Vertical scroll offsets, keyed by note id.
 *
 * They cannot be read back out of the DOM on demand: a covered pane's sheet
 * (and every pane but the last on a phone) is `display: none`, where Chrome
 * reports `scrollTop` as 0. So each sheet records its offset continuously
 * while it is visible, and rebuilds/reveals restore from here.
 */
const scrollMemory = new Map();

/** Which sheets were visible at the last geometry pass, for reveal detection. */
const sheetVisibility = new WeakMap();

const search = {
  generation: 0,
  timer: 0,
  results: [],
  active: -1,
  open: false,
  /** True between the field changing and that query's results landing. */
  pending: false,
};

const preview = {
  timer: 0,
  generation: 0,
  visible: false,
};

/* -------------------------------------------------------------- helpers --- */

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A note id is a vault-relative POSIX path. Anything that could be read as
 * something else in a URL — a protocol-relative `//host`, a `..` walk, a
 * backslash, an empty segment — is not an id this reader will accept.
 */
function isValidNoteId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('/') || id.includes('//') || id.includes('\\')) return false;
  return id.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function designPaneId(url) {
  return `design-pane:${encodeURIComponent(url)}`;
}

/**
 * A design example is a typed pane, like a Wikipedia article: it has no note
 * behind it, but it still belongs in the stack so Back, close and reload work.
 */
function designUrlFromPaneId(id) {
  if (typeof id !== 'string' || !id.startsWith('design-pane:')) return null;
  try {
    const url = decodeURIComponent(id.slice('design-pane:'.length));
    return /^\/design\//.test(url) && !url.includes('..') && !url.includes('\\') ? url : null;
  } catch {
    return null;
  }
}

/**
 * A pane id is a note, a design example or a Wikipedia article.
 *
 * The reserved `demo:` ids from the old pane-based account design are never
 * panes again: they are read out of old URLs and migrated to the matching
 * full-page region (see `view-route.js`), but they cannot be opened here.
 */
function isValidPaneId(id) {
  if (isDemoPaneId(id)) return false;
  return Boolean(designUrlFromPaneId(id)) || Boolean(wikipediaArticle(id)) || isValidNoteId(id);
}

function noteHref(id) {
  // Typed external ids use one encoded URL segment and cannot collide with vault paths.
  if (designUrlFromPaneId(id)) return '/' + encodeURIComponent(id);
  if (wikipediaArticle(id)) return '/' + encodeURIComponent(id);
  // Defensive: an unusable id must never become a link the browser reads as
  // another origin (or a rootless `//path`).
  if (!isValidNoteId(id)) return '/';
  return './?note=' + encodeURIComponent(id);
}

/**
 * The URL for a whole route: the reading stack plus the region.
 *
 * `view=reader` is the absence of the parameter, so a stack has exactly one
 * reading URL however it was reached. Everything is relative to the current
 * page, which is what keeps the static build working under a project subpath.
 */
function stackHref(ids, { view = VIEW_READER, hash = '' } = {}) {
  return `./${buildRouteQuery({ ids: ids.filter(isValidPaneId), view, hash })}`;
}

/**
 * Resolve the whole URL: the reading stack, the region and the fragment.
 *
 * Unusable ids are dropped, reserved legacy ids are migrated to their region by
 * `parseViewRoute`, and a URL that names nothing usable falls back to the home
 * note — including in an account URL, so "Return to notes" always has a
 * destination.
 */
function routeFromUrl() {
  const parsed = parseViewRoute(window.location.search, window.location.hash);

  const ids = [];
  let invalid = false;
  for (const id of parsed.ids) {
    if (isValidPaneId(id)) ids.push(id);
    else invalid = true;
  }

  let nextIds = ids;
  let needsReplace = parsed.changed || invalid;
  // Page mode shows one note. An older stacked URL still opens its newest note
  // rather than a row the reader did not ask for.
  if (currentReadingMode() === 'page' && nextIds.length > 1) {
    nextIds = [nextIds[nextIds.length - 1]];
    needsReplace = true;
  }
  if (!nextIds.length && state.bootstrap?.defaultNoteId) {
    nextIds = [state.bootstrap.defaultNoteId];
    needsReplace = true;
  }

  return {
    ids: nextIds,
    view: parsed.view,
    hash: safeDecode(parsed.hash),
    needsReplace,
    // Only the reader has nothing to show for an empty vault; an account view
    // still explains itself.
    empty: !nextIds.length && parsed.view === VIEW_READER,
  };
}

/**
 * Write the URL for a route, never throwing. A browser can refuse a history
 * write (a SecurityError for a URL it reads as another origin, for instance);
 * the caller must then put its state back so the DOM and the URL still agree.
 */
function writeRouteUrl(ids, { view = VIEW_READER, hash = '', replace = false } = {}) {
  // Never write a URL that does not describe the whole route: a caller that
  // hands us a junk id gets a refusal (and restores its state) instead of a
  // silently shorter URL that disagrees with what is on screen.
  if (!ids.every(isValidPaneId)) return false;
  const href = stackHref(ids, { view, hash });
  try {
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    return true;
  } catch {
    return false;
  }
}

/** Read the URL once and put both regions in step with it. */
function reconcileRoute() {
  const route = routeFromUrl();
  if (route.needsReplace) {
    // Best effort: if the browser refuses even this same-origin replace, the
    // valid route is still what gets rendered, so nothing is built from a junk
    // id; the stale segment simply stays in the address bar.
    writeRouteUrl(route.ids, { view: route.view, hash: route.hash, replace: true });
  }
  applyRoute(route);
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Expose exactly one main region. The other keeps its DOM and is not focusable. */
function showRegion(view) {
  const account = isAccountView(view);
  els.stack.hidden = account;
  els.account.hidden = !account;
  document.body.dataset.region = account ? 'account' : 'reader';
}

function applyRoute(route) {
  if (route.empty) {
    state.view = VIEW_READER;
    state.routeHash = route.hash;
    state.stack = route.ids;
    showRegion(VIEW_READER);
    syncTrackingPause();
    if (state.bootstrapError) renderBootstrapError(state.bootstrapError);
    else renderEmptyVault();
    return;
  }
  if (isAccountView(route.view)) {
    enterAccountView(route);
    return;
  }
  enterReaderView({ ids: route.ids, hash: route.hash });
}

/**
 * Build an API query string, dropping any `limit` the server would reject.
 * The server treats only `>= 1` as valid, so a `0` must never be sent.
 */
function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (key === 'limit') {
      const limit = Math.trunc(Number(value));
      if (!Number.isFinite(limit) || limit < 1) continue;
      params.set('limit', String(Math.min(limit, 50)));
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

function friendlyName(id) {
  const demoLabel = demoPaneLabel(id);
  if (demoLabel) return demoLabel;
  const design = designUrlFromPaneId(id);
  if (design) {
    const file = decodeURIComponent(design.split('#')[0].split('/').pop() || 'Design example');
    return `${file.replace(/\.html?$/i, '')} · design`;
  }
  const wikipedia = wikipediaArticle(id);
  if (wikipedia) return wikipedia.title;
  const parts = String(id).split('/').filter(Boolean);
  return parts[parts.length - 1] || String(id);
}

function scrollBehavior() {
  return reducedMotion.matches ? 'auto' : 'smooth';
}

function appTitle() {
  return state.bootstrap?.app?.title || 'Vitruvian Institute';
}

function announce(message) {
  els.status.textContent = message;
}

/* --------------------------------------------------------------- fetching --- */

function getNote(id) {
  if (!noteCache.has(id)) {
    const endpoint = wikipediaArticle(id) ? '/api/wikipedia' : '/api/note';
    const request = fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(data?.error?.message || `Note ${id} could not be loaded`);
          error.status = response.status;
          error.code = data?.error?.code || null;
          throw error;
        }
        if (!data?.note) throw new Error('Malformed note response');
        return data.note;
      })
      .catch((error) => {
        // A failed read is not cached; reloading or retrying may succeed.
        if (noteCache.get(id) === request) noteCache.delete(id);
        throw error;
      });
    noteCache.set(id, request);
  }
  return noteCache.get(id);
}

async function getBootstrap() {
  const response = await fetch('/api/bootstrap', { headers: { accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error?.message || 'The notes index could not be loaded.');
  }
  return data;
}

/* -------------------------------------------------------------- boot/chrome --- */

async function boot() {
  dismissPreview();
  closeSearch();
  state.ready = false;
  els.input.disabled = true;

  let bootstrap;
  try {
    bootstrap = await getBootstrap();
  } catch (error) {
    state.bootstrap = null;
    state.bootstrapError = error;
    // The account region does not need the notes index, so the URL is still
    // reconciled: `?view=account` and `?view=settings` must open even now.
    reconcileRoute();
    return;
  }

  state.bootstrap = bootstrap;
  state.bootstrapError = null;
  state.ready = true;
  applyChrome(bootstrap);
  reconcileRoute();
}

const RANDOM_KEY = 'vitruvian.random';

function randomPreferred() {
  try {
    return localStorage.getItem(RANDOM_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Random is an opt-in extra, not part of the default header. */
function syncRandom() {
  els.random.hidden = state.bootstrap?.features?.random === false || !randomPreferred();
}

function applyChrome(bootstrap) {
  els.title.textContent = appTitle();
  els.title.title = 'About these notes';
  els.title.setAttribute('aria-label', `${appTitle()} — about these notes`);
  document.title = appTitle();

  syncRandom();
  const searchEnabled = bootstrap.features?.search !== false;
  els.form.hidden = !searchEnabled;
  els.input.disabled = !searchEnabled;
  state.previewEnabled = bootstrap.features?.preview !== false;
}

/* ---------------------------------------------------------- page regions --- */

/**
 * Come back to the reading stack, or build it if it is not on screen yet.
 *
 * Returning from an account view keeps the panes that were already there: the
 * reader's horizontal position and every note's scroll offset are restored from
 * the memory the sheets keep while they are visible, and an unchanged stack is
 * never rebuilt.
 */
function enterReaderView({ ids, hash = '', heading = null, focusElement = false, focusIndex = null, animate = false }) {
  const returning = state.view !== VIEW_READER;
  state.view = VIEW_READER;
  state.routeHash = hash;
  showRegion(VIEW_READER);
  syncTrackingPause();
  // The account region's evidence URLs must not outlive the view showing them.
  if (returning) demo?.releasePane(els.accountContent);

  // Nothing to show: the notes index never loaded, or the vault is empty. Say
  // so here rather than leaving the reader blank after an account view.
  if (!ids.length) {
    state.stack = [];
    if (state.bootstrapError) renderBootstrapError(state.bootstrapError);
    else renderEmptyVault();
    return;
  }

  const unchanged = state.panes.length > 0
    && state.panes.length === ids.length
    && sameIds(ids, state.stack);

  if (unchanged) {
    restoreReaderPosition({ focusElement, focusIndex });
    if (heading) {
      const pane = state.panes[state.panes.length - 1];
      if (pane) scrollToHeading(pane, heading, scrollBehavior());
    } else if (hash) {
      scrollLastPaneToHash(hash);
    }
    return;
  }

  state.stack = ids;
  renderStack({ focusElement, focusIndex, heading, hash, animate });
}

/** Show an account region, leaving the reading stack's DOM untouched. */
function enterAccountView({ ids, view, hash = '' }) {
  if (state.view === VIEW_READER) {
    captureReaderPosition();
    // The row is about to be hidden, where every sheet reports a zero box.
    // Forgetting the last visibility means the reveal restores each offset.
    for (const pane of state.panes) {
      const sheet = pane.querySelector('.pane-sheet');
      if (sheet) sheetVisibility.delete(sheet);
    }
  }

  state.view = view;
  state.stack = ids;
  state.routeHash = hash;
  dismissPreview();
  closeSearch();
  showRegion(view);
  // A hidden reader is not being read, and no geometry pass may pick a pane
  // back up behind the account page.
  tracker?.setActiveNote(null);
  syncTrackingPause();
  renderAccountView(view, { focus: true });
}

function captureReaderPosition() {
  state.stackScrollLeft = els.stack.scrollLeft;
  for (const pane of state.panes) {
    const sheet = pane.querySelector('.pane-sheet');
    if (sheet) rememberPaneScroll(pane, sheet);
  }
}

function restoreReaderPosition({ focusElement = false, focusIndex = null } = {}) {
  for (const pane of state.panes) restorePaneScroll(pane);
  if (els.stack.scrollLeft !== state.stackScrollLeft) els.stack.scrollLeft = state.stackScrollLeft;
  scheduleGeometry();
  // Focus straight away: `preventScroll` means it cannot move the row itself.
  if (focusElement) {
    const at = focusIndex === null ? state.panes.length - 1 : focusIndex;
    state.panes[at]?.focus({ preventScroll: true });
  }

  // The geometry pass toggles the covered/overlapped classes, and Chrome can
  // nudge a sticky scroller's offset while it recomputes them. Put the row back
  // once that has settled, so the reader lands where they actually left it.
  window.requestAnimationFrame(() => {
    if (state.view !== VIEW_READER) return;
    if (els.stack.scrollLeft !== state.stackScrollLeft) els.stack.scrollLeft = state.stackScrollLeft;
  });
}

function scrollLastPaneToHash(hash) {
  if (!hash) return;
  const pane = state.panes[state.panes.length - 1];
  if (pane) scrollToHeading(pane, hash, 'auto');
}

/* --------------------------------------------------------- account region --- */

/** A per-visit token, so a slow render cannot commit over a newer region. */
let accountRenderToken = 0;

/**
 * One quiet entry to the account page. The page itself carries the session,
 * portfolio and settings; the header does not try to be an identity badge.
 */
function syncAccountLabel() {
  // A guest gets one quiet way in. The gear is the settings tab itself.
  els.login.hidden = Boolean(demo?.session);
}

function syncAccountNav(view) {
  const hash = state.routeHash ?? '';
  els.accountBack.href = stackHref(state.stack, { view: VIEW_READER, hash });
  els.accountUser.href = stackHref(state.stack, { view: VIEW_ACCOUNT, hash });
  els.accountSettings.href = stackHref(state.stack, { view: VIEW_SETTINGS, hash });
  els.accountAdmin.href = stackHref(state.stack, { view: VIEW_ADMIN, hash });

  for (const link of [els.accountUser, els.accountSettings, els.accountAdmin]) {
    if (link.dataset.accountView === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // Admin navigation is authorized, and only inside the account region.
  els.accountAdmin.hidden = !(demo?.session && demo?.canReview(demo.session));
}

async function renderAccountView(view, { focus = false } = {}) {
  const token = ++accountRenderToken;
  state.view = view;
  syncAccountNav(view);
  document.title = `${VIEW_TITLES[view] ?? 'Account'} · ${appTitle()}`;

  const scrollTop = els.account.scrollTop;

  // Choosing the store is asynchronous. Wait for it before showing the
  // "unavailable" region, so a slow config load is not reported as a failure.
  if (!demo && demoBoot) {
    await demoBoot;
    if (token !== accountRenderToken || state.view !== view) return;
  }

  if (!demo) {
    els.accountContent.replaceChildren(demoUnavailable());
    if (focus) focusAccountHeading();
    return;
  }

  // A quiet placeholder after a short delay: instant renders never flash it,
  // slow ones say the page is still coming.
  const loadingTimer = window.setTimeout(() => {
    if (token !== accountRenderToken || state.view !== view) return;
    if (els.accountContent.childElementCount) return;
    const loading = document.createElement('p');
    loading.className = 'account-loading';
    loading.setAttribute('role', 'status');
    loading.append(
      Object.assign(document.createElement('span'), { className: 'account-loading-dot', ariaHidden: 'true' }),
      document.createTextNode('Loading'),
    );
    els.accountContent.replaceChildren(loading);
  }, 140);

  const committed = await demo.renderPane(els.accountContent, view, {
    isCurrent: () => token === accountRenderToken && state.view === view,
  });
  window.clearTimeout(loadingTimer);
  if (token !== accountRenderToken) return;
  // A refresh after a pin or a review must not move the reader's place.
  els.account.scrollTop = scrollTop;
  if (committed && focus) focusAccountHeading();
}

function focusAccountHeading() {
  const heading = els.accountContent.querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    return;
  }
  els.accountContent.focus({ preventScroll: true });
}

function demoUnavailable() {
  const wrap = document.createElement('div');
  wrap.className = 'demo-failure';
  const heading = document.createElement('h1');
  heading.className = 'demo-title';
  heading.textContent = 'User info is unavailable';
  const lede = document.createElement('p');
  lede.className = 'demo-lede';
  lede.textContent = 'The local demo could not start in this browser. The notes themselves are unaffected.';
  wrap.append(heading, lede);
  return wrap;
}

/**
 * Switch to a full-page account region. The reading query parameters and the
 * hash are preserved, so "Return to notes" only has to remove `view`.
 */
function goToView(view) {
  if (!isAccountView(view)) return;
  if (state.view === view) {
    // Already there: refreshing is not a navigation, so no history entry.
    renderAccountView(view, { focus: false });
    return;
  }
  const hash = state.routeHash ?? '';
  if (!writeRouteUrl(state.stack, { view, hash })) return;
  enterAccountView({ ids: state.stack, view, hash });
}

function goToReader() {
  if (state.view === VIEW_READER) return;
  const hash = state.routeHash ?? '';
  if (!writeRouteUrl(state.stack, { view: VIEW_READER, hash })) return;
  enterReaderView({ ids: state.stack, hash, focusElement: true });
}

/* ------------------------------------------------------------- the stack --- */

let renderToken = 0;

/**
 * Rebuild every pane from `state.stack`.
 *
 * A full rebuild is what `popstate` and ordinary navigation both want: it keeps
 * the DOM and the URL in one-to-one correspondence. Panes are created
 * synchronously so the horizontal geometry is final immediately; their bodies
 * fill in as their note requests resolve.
 */
function renderStack({ focusElement = false, focusIndex = null, heading = null, hash = '', animate = true } = {}) {
  const token = ++renderToken;
  dismissPreview();
  closeSearch();
  // A rebuild replaces every pane, so nothing inside one may outlive it.
  demo?.closeDialogs();
  for (const pane of state.panes) demo?.releasePane(pane);
  tracker?.clearRendered();
  pendingDemoDecorations.clear();

  els.stack.replaceChildren();
  state.panes = [];

  state.stack.forEach((id, index) => {
    const pane = buildPane(id, index);
    els.stack.append(pane);
    state.panes.push(pane);
    fillPane(pane, id, index, token, {
      heading: index === state.stack.length - 1 ? heading : null,
      hash: index === state.stack.length - 1 ? hash : '',
      animate,
    });
  });

  const last = state.stack[state.stack.length - 1];
  document.title = last ? `${friendlyName(last)} · ${appTitle()}` : appTitle();
  scheduleGeometry();

  if (state.panes.length) {
    const at = focusIndex === null ? state.panes.length - 1 : focusIndex;
    // Wait for the browser to lay the new panes out before measuring them.
    window.requestAnimationFrame(() => {
      if (token !== renderToken) return;
      centerPane(at, animate ? scrollBehavior() : 'auto');
      if (focusElement) state.panes[at]?.focus({ preventScroll: true });
    });
  }
}

function buildPane(id, index) {
  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.noteId = id;
  pane.dataset.index = String(index);
  pane.style.setProperty('--index', String(index));
  // Later panes paint over earlier ones; this is the stacking order the
  // covered-pane geometry assumes.
  pane.style.zIndex = String(index + 1);
  pane.tabIndex = -1;
  pane.setAttribute('aria-label', friendlyName(id));

  const spine = document.createElement('div');
  spine.className = 'pane-spine';
  const spineTitle = document.createElement('a');
  spineTitle.className = 'pane-spine-title';
  spineTitle.href = noteHref(id);
  spineTitle.dataset.noteId = id;
  spineTitle.textContent = friendlyName(id);
  spineTitle.setAttribute('aria-label', friendlyName(id));
  spineTitle.title = friendlyName(id);
  spine.append(spineTitle);

  const sheet = document.createElement('div');
  sheet.className = 'pane-sheet';
  const article = document.createElement('article');
  article.className = 'note-content';
  article.setAttribute('aria-busy', 'true');
  const backlinks = document.createElement('details');
  backlinks.className = 'backlinks';
  backlinks.hidden = true;
  sheet.append(article, backlinks);
  // Record the offset as it happens; reading it later is unreliable because a
  // covered sheet is `display: none`.
  sheet.addEventListener('scroll', () => rememberPaneScroll(pane, sheet), { passive: true });

  pane.append(spine, sheet);

  // Closing is a pane-level action, so the control lives on the pane rather than
  // in a menu. The last remaining pane has nothing to close and gets none.
  if (state.stack.length > 1) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pane-close';
    close.dataset.closeIndex = String(index);
    close.setAttribute('aria-label', `Close ${friendlyName(id)}`);
    close.title = `Close ${friendlyName(id)}`;
    close.innerHTML = '<span aria-hidden="true">×</span>';
    pane.append(close);
  }

  return pane;
}

function rememberPaneScroll(pane, sheet) {
  const id = pane.dataset.noteId;
  if (!id) return;
  // A hidden element reports 0 for `scrollTop`; never let that erase the
  // position the reader actually left it at.
  if (!sheet.getClientRects().length) return;
  scrollMemory.set(id, sheet.scrollTop);
}

/** Put a pane's remembered offset back, once it has a box to scroll. */
function restorePaneScroll(pane) {
  const id = pane.dataset.noteId;
  const sheet = pane.querySelector('.pane-sheet');
  if (!id || !sheet) return;
  // Hidden = a dead scroller. The reveal (see `syncSheetVisibility`) will do it.
  if (!sheet.getClientRects().length) return;
  const top = scrollMemory.get(id) || 0;
  if (Math.abs(sheet.scrollTop - top) > 1) sheet.scrollTop = top;
}

/** Restore a sheet that has just gone from hidden to visible. */
function syncSheetVisibility(pane, index, narrow) {
  const sheet = pane.querySelector('.pane-sheet');
  if (!sheet) return;
  const visible = narrow ? index === state.panes.length - 1 : !pane.classList.contains('is-covered');
  const wasVisible = sheetVisibility.get(sheet);
  sheetVisibility.set(sheet, visible);
  // Anything but a sheet that was already visible on screen is restored: a
  // newly revealed sheet, and one whose visibility was forgotten while the row
  // was hidden behind an account view.
  if (visible && wasVisible !== true) restorePaneScroll(pane);
}

async function fillPane(pane, id, index, token, { heading, hash = '', animate }) {
  const article = pane.querySelector('.note-content');
  const backlinks = pane.querySelector('.backlinks');
  const spineTitle = pane.querySelector('.pane-spine-title');

  const designUrl = designUrlFromPaneId(id);
  const canvas = Boolean(designUrl && designPaneLayout(designUrl) === 'canvas');
  pane.classList.toggle('is-design-canvas', canvas);
  if (designUrl) {
    article.removeAttribute('aria-busy');
    article.replaceChildren();
    const viewport = document.createElement('div');
    viewport.className = canvas ? 'design-pane-viewport is-canvas' : 'design-pane-viewport';
    const frame = document.createElement('iframe');
    frame.src = designUrl;
    frame.title = friendlyName(id);
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    viewport.append(frame);
    article.append(viewport);
    backlinks.replaceChildren();
    backlinks.hidden = true;
    applyNoteTitle(pane, spineTitle, friendlyName(id), index);

    // A canvas already implements zoom/focus. Give it real responsive space;
    // scaling its whole viewer would shrink controls and double-scale previews.
    if (!canvas) {
      const fit = () => {
        const scale = Math.min(1, viewport.clientWidth / 1180);
        frame.style.transform = `scale(${scale})`;
        viewport.style.height = `${Math.max(320, 780 * scale)}px`;
      };
      fit();
      if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(viewport);
    }
    restorePaneScroll(pane);
    scheduleGeometry();
    return;
  }

  try {
    const note = await getNote(id);
    if (token !== renderToken || !pane.isConnected) return;

    article.removeAttribute('aria-busy');
    article.innerHTML = note.html;
    renderBreadcrumbs(article, note);
    if (note.source === 'wikipedia') renderWikipediaSource(article, note.sourceUrl);
    renderBacklinks(backlinks, note);
    applyNoteTitle(pane, spineTitle, note.title, index);
    // The only hook into note rendering: one control, only when the frontmatter
    // said `activity: true`. Previews and Markdown never reach this path.
    if (demo) {
      demo.decorateArticle(article, note);
    } else {
      // The demo boots beside the reader: a note that rendered before the store
      // was chosen is decorated and counted as soon as the store exists.
      pendingDemoDecorations.set(article, { id, note, rendered: false });
    }
    // A page is counted only once the note has really rendered, and only for a
    // note from the vault. Wikipedia articles and design panes are not pages.
    if (note.source === 'vault') {
      if (tracker) tracker.markRendered(id);
      else if (pendingDemoDecorations.has(article)) pendingDemoDecorations.get(article).rendered = true;
    }

    // The content (and so the scrollable height) is only real now.
    restorePaneScroll(pane);

    // A canonical `/<note>#heading` URL (cmd-click, reload) should land on the
    // same heading a normal click would. In-app navigation carries a heading
    // instead of a fragment.
    const fragment = index === state.stack.length - 1 && !heading ? hash : '';
    if (heading) scrollToHeading(pane, heading, animate ? scrollBehavior() : 'auto');
    else if (fragment) scrollToHeading(pane, fragment, 'auto');

    scheduleGeometry();
  } catch (error) {
    if (token !== renderToken || !pane.isConnected) return;
    article.removeAttribute('aria-busy');
    renderNoteError(article, backlinks, id, error);
    pane.setAttribute('aria-label', `${friendlyName(id)} (could not be read)`);
    scheduleGeometry();
  }
}

/**
 * One quiet line of location context above the note. The trail is curated in
 * frontmatter and exported by the build; nothing here guesses from link history.
 */
function renderBreadcrumbs(article, note) {
  const trail = Array.isArray(note.breadcrumbs) ? note.breadcrumbs : [];
  if (!trail.length) return;
  const nav = document.createElement('nav');
  nav.className = 'breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');
  trail.forEach((crumb, index) => {
    if (index) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '›';
      nav.append(separator);
    }
    const link = document.createElement('a');
    link.className = 'breadcrumb-link';
    link.href = noteHref(crumb.id);
    link.dataset.noteId = crumb.id;
    link.textContent = crumb.title;
    nav.append(link);
  });
  article.prepend(nav);
}

function applyNoteTitle(pane, spineTitle, title, index) {
  const safeTitle = String(title || friendlyName(pane.dataset.noteId));
  pane.setAttribute('aria-label', safeTitle);
  spineTitle.textContent = safeTitle;
  spineTitle.setAttribute('aria-label', safeTitle);
  spineTitle.title = safeTitle;
  if (index === state.stack.length - 1) document.title = `${safeTitle} · ${appTitle()}`;
}

function renderWikipediaSource(article, sourceUrl) {
  const source = document.createElement('aside');
  source.className = 'wikipedia-source';
  source.append('Wikipedia · simplified article · ');
  const original = document.createElement('a');
  original.href = sourceUrl;
  original.target = '_blank';
  original.rel = 'noreferrer noopener';
  original.dataset.externalBrowser = 'true';
  original.textContent = 'Original & authors';
  source.append(original, ' · ');
  const license = document.createElement('a');
  license.href = 'https://creativecommons.org/licenses/by-sa/4.0/';
  license.target = '_blank';
  license.rel = 'noreferrer noopener';
  license.textContent = 'CC BY-SA';
  source.append(license);
  article.prepend(source);
}

/* ------------------------------------------------------------- backlinks --- */

function renderBacklinks(footer, note) {
  footer.replaceChildren();
  const backlinks = Array.isArray(note.backlinks) ? note.backlinks : [];
  // A note with no incoming links gets no footer at all: the reading comes first.
  footer.hidden = note.source === 'wikipedia' || backlinks.length === 0;
  if (footer.hidden) return;

  // Collapsed by default. The links stay one click away without competing with
  // the note for attention.
  footer.open = false;
  const summary = document.createElement('summary');
  summary.className = 'backlinks-summary';
  summary.textContent = `Links to this note (${backlinks.length})`;
  footer.append(summary);

  const list = document.createElement('ul');
  list.className = 'backlink-list';
  for (const backlink of backlinks) {
    const item = document.createElement('li');
    const card = document.createElement('a');
    card.className = 'backlink-card';
    card.href = noteHref(backlink.id);
    card.dataset.noteId = backlink.id;

    const title = document.createElement('span');
    title.className = 'backlink-title';
    title.textContent = backlink.title || friendlyName(backlink.id);

    // The path is only useful when it says something the title does not.
    const label = backlink.title || friendlyName(backlink.id);
    if (label.trim().toLowerCase() !== String(backlink.id).trim().toLowerCase()) {
      const id = document.createElement('span');
      id.className = 'backlink-id';
      id.textContent = backlink.id;
      card.append(title, id);
    } else {
      card.append(title);
    }
    item.append(card);
    list.append(item);
  }
  footer.append(list);
}

/* ----------------------------------------------------------------- errors --- */

function renderNoteError(article, footer, id, error) {
  footer.replaceChildren();
  footer.hidden = true;
  article.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'note-error';
  wrap.setAttribute('role', 'alert');

  const heading = document.createElement('h1');
  heading.textContent = 'This note could not be read';

  const reason = document.createElement('p');
  reason.textContent =
    error?.status === 404
      ? 'No readable note lives at this address. It may have moved, or it may be private.'
      : 'The reader could not load this note just now.';

  const address = document.createElement('p');
  address.className = 'note-error-id';
  address.textContent = id;

  wrap.append(heading, reason, address);

  const wikipedia = wikipediaArticle(id);
  if (wikipedia) {
    heading.textContent = 'This Wikipedia article could not be read';
    reason.textContent = error?.message || 'Wikipedia may be unavailable. Try again or open the original.';
    address.textContent = wikipedia.title;
    const original = document.createElement('a');
    original.href = wikipedia.url;
    original.target = '_blank';
    original.rel = 'noreferrer noopener';
    original.dataset.externalBrowser = 'true';
    original.textContent = 'Open original on Wikipedia';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => renderStack({ animate: false }));
    wrap.append(original, document.createElement('br'), retry);
    article.append(wrap);
    return;
  }

  const defaultId = state.bootstrap?.defaultNoteId;
  if (defaultId) {
    const back = document.createElement('a');
    back.className = 'note-link';
    back.href = noteHref(defaultId);
    back.dataset.noteId = defaultId;
    back.textContent = 'Go to the default note';
    // A broken pane is not a place to build on: return to the start of the
    // stack rather than appending the default note behind the error.
    back.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      goHome();
    });
    wrap.append(back);
  } else {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Reload the reader';
    retry.addEventListener('click', () => window.location.reload());
    wrap.append(retry);
  }

  article.append(wrap);
}

function clearStackForMessage() {
  renderToken += 1;
  for (const pane of state.panes) demo?.releasePane(pane);
  state.panes = [];
  els.stack.replaceChildren();
  dismissPreview();
  closeSearch();
  tracker?.clearRendered();
  tracker?.setActiveNote(null);
  pendingDemoDecorations.clear();
}

function renderBootstrapError(error) {
  clearStackForMessage();
  document.title = appTitle();

  const wrap = document.createElement('section');
  wrap.className = 'stack-message';
  wrap.setAttribute('role', 'alert');

  const heading = document.createElement('h1');
  heading.textContent = 'These notes could not be loaded';

  const reason = document.createElement('p');
  reason.textContent = 'The reader could not reach the notes index. It may still be starting up.';

  const detail = document.createElement('p');
  detail.className = 'note-error-id';
  detail.textContent = error?.message || 'Unknown error';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => boot());

  wrap.append(heading, reason, detail, retry);
  els.stack.append(wrap);
}

function renderEmptyVault() {
  clearStackForMessage();
  document.title = appTitle();

  const wrap = document.createElement('section');
  wrap.className = 'stack-message';

  const heading = document.createElement('h1');
  heading.textContent = 'No readable notes';

  const reason = document.createElement('p');
  reason.textContent = 'This vault does not contain any public notes yet.';

  wrap.append(heading, reason);
  els.stack.append(wrap);
}

/* -------------------------------------------------------------- geometry --- */

let geometryFrame = 0;

function scheduleGeometry() {
  if (geometryFrame) return;
  geometryFrame = window.requestAnimationFrame(() => {
    geometryFrame = 0;
    updateCovered();
  });
}

/**
 * Work out which panes are covered, from real rectangles rather than by
 * re-deriving the scroll maths.
 *
 * Two states matter:
 *  - `is-overlapped`: the next pane's left edge has crossed this pane's right
 *    edge, so this pane is casting a shadow.
 *  - `is-covered`: the next pane has also reached its sticky resting offset,
 *    which means it has covered everything except this pane's 40px spine. Only
 *    then does the body give way to the vertical title. Collapsing at the first
 *    pixel of overlap would leave a blank strip between the panes.
 *
 * The equal widths and increasing sticky offsets mean the immediate neighbour
 * is enough: if a later pane overlaps, the immediate one already does.
 */
function updateCovered() {
  // While an account region is showing, the reading row is hidden: it is not
  // being read, and every pane reports a zero rectangle. Nothing here may pick
  // a pane back up behind the account page.
  if (isAccountView(state.view)) {
    tracker?.setActiveNote(null);
    return;
  }

  const panes = state.panes;
  const narrow = narrowLayout.matches;

  for (let index = 0; index < panes.length; index += 1) {
    const pane = panes[index];
    const next = panes[index + 1];
    let overlapped = false;
    let covered = false;

    if (!narrow && next) {
      const paneRect = pane.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      overlapped = nextRect.left < paneRect.right - 0.5;

      // The computed `left` is the pane's sticky offset. When the next pane has
      // slid all the way to it, only this pane's spine is still showing.
      const stickyLeft = Number.parseFloat(window.getComputedStyle(next).left) || 0;
      covered = overlapped && nextRect.left <= stickyLeft + 0.5;
    }

    pane.classList.toggle('is-overlapped', overlapped);
    pane.classList.toggle('is-covered', covered);
    syncSheetVisibility(pane, index, narrow);
  }

  // Reading is measured against the pane the reader is actually looking at: the
  // one showing the most of itself inside the row. On a phone that is the only
  // visible pane; on a wide screen it is the frontmost pane in view.
  tracker?.setActiveNote(mostVisiblePaneId());
}

function mostVisiblePaneId() {
  const row = els.stack.getBoundingClientRect();
  let bestId = null;
  let bestWidth = 0;
  for (const pane of state.panes) {
    const rect = pane.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, row.right) - Math.max(rect.left, row.left));
    // A pane hidden by the narrow layout, or scrolled out of the row, shows nothing.
    if (width <= 0) continue;
    // A tie goes to the later pane: in this stack the newest pane is in front.
    if (width >= bestWidth - 0.5) {
      bestWidth = width;
      bestId = pane.dataset.noteId ?? null;
    }
  }
  return bestId;
}

/**
 * Bring one pane towards the middle of the scroller.
 *
 * The panes are laid out edge to edge, so summing the widths of the panes
 * before this one gives its flow position. `offsetLeft` is not usable here:
 * for a sticky pane Chrome reports a position that already includes the sticky
 * displacement, and the `right: -585px` constraint pulls the rightmost panes
 * left before the row has scrolled. Only scroll when the stack overflows.
 */
function centerPane(index, behavior) {
  const stackEl = els.stack;
  const pane = state.panes[index];
  if (!pane) return;

  const overflowing = stackEl.scrollWidth > stackEl.clientWidth + 1;
  if (!overflowing) return;

  let flowLeft = 0;
  for (let before = 0; before < index; before += 1) {
    flowLeft += state.panes[before].offsetWidth;
  }

  const max = stackEl.scrollWidth - stackEl.clientWidth;
  const centered = flowLeft + pane.offsetWidth / 2 - stackEl.clientWidth / 2;
  stackEl.scrollTo({
    left: Math.max(0, Math.min(max, centered)),
    top: 0,
    behavior,
  });
}

function scrollToHeading(pane, heading, behavior = 'auto') {
  if (!heading) return;
  const sheet = pane.querySelector('.pane-sheet');
  if (!sheet) return;

  let target = null;
  try {
    target = sheet.querySelector(`#${window.CSS.escape(heading)}`);
  } catch {
    target = null;
  }
  if (!target) return;

  const top =
    sheet.scrollTop + target.getBoundingClientRect().top - sheet.getBoundingClientRect().top - 20;
  sheet.scrollTo({ top: Math.max(0, top), behavior });
}

/* ------------------------------------------------------------ navigation --- */

function navigateFromPane(index, id, heading) {
  if (!state.ready || !isValidPaneId(id)) return;
  dismissPreview();
  closeSearch();

  const existing = state.stack.indexOf(id);
  if (existing !== -1) {
    // Already open. From the reader, reveal it without a history entry; from an
    // account region, come back to the reading stack that already holds it.
    if (state.view !== VIEW_READER) {
      if (!writeRouteUrl(state.stack, { view: VIEW_READER, hash: heading ?? '' })) return;
      enterReaderView({
        ids: state.stack,
        hash: heading ?? '',
        focusElement: true,
        focusIndex: Math.min(existing, state.stack.length - 1),
      });
      return;
    }
    const pane = state.panes[existing];
    if (pane) {
      centerPane(existing, scrollBehavior());
      pane.focus({ preventScroll: true });
      if (heading) scrollToHeading(pane, heading, scrollBehavior());
    }
    return;
  }

  const safeIndex = state.stack.length
    ? Math.max(0, Math.min(index, state.stack.length - 1))
    : 0;
  // Page mode follows a link to one page, so browser Back is the path; stacked
  // mode keeps the earlier panes and appends to the right of the clicked one.
  const next = currentReadingMode() === 'page'
    ? [id]
    : [...state.stack.slice(0, safeIndex + 1), id];

  // Selecting a note always leaves the account region and writes the reading
  // URL, so Random and Search keep working from User info, Settings and Admin.
  if (!writeRouteUrl(next, { view: VIEW_READER })) {
    // The browser refused the URL. Put the old stack back rather than showing
    // panes the address bar does not describe.
    renderStack({ animate: false });
    announce('That note could not be opened.');
    return;
  }

  enterReaderView({ ids: next, heading, focusElement: true, animate: true });
}

/**
 * Close one pane. The remaining panes keep their order; closing the first one
 * promotes the next note to the path, which is what makes closing the page you
 * started on behave like stepping back through the row.
 *
 * Closing pushes a history entry rather than replacing one: Back reopens the
 * pane you just closed, so closing is never destructive.
 */
function closePane(index) {
  if (currentReadingMode() === 'page') return;
  if (!state.ready || state.stack.length <= 1) return;
  if (index < 0 || index >= state.stack.length) return;

  const previous = state.stack;
  const closed = previous[index];
  const next = previous.filter((_, at) => at !== index);

  if (!writeRouteUrl(next, { view: VIEW_READER })) {
    state.stack = previous;
    renderStack({ animate: false });
    announce('That page could not be closed.');
    return;
  }

  state.stack = next;
  renderStack({ animate: true });
  announce(`Closed ${friendlyName(closed)}.`);
}

function goHome() {
  const defaultId = state.bootstrap?.defaultNoteId;
  if (!state.ready || !defaultId) return;
  dismissPreview();
  closeSearch();

  const alreadyHome = state.stack.length === 1 && state.stack[0] === defaultId;
  const putHomeOnTop = () => {
    const sheet = state.panes[0]?.querySelector('.pane-sheet');
    sheet?.scrollTo({ top: 0, behavior: scrollBehavior() });
    centerPane(0, scrollBehavior());
    state.panes[0]?.focus({ preventScroll: true });
  };

  if (alreadyHome && state.view === VIEW_READER) {
    putHomeOnTop();
    return;
  }

  if (!writeRouteUrl([defaultId], { view: VIEW_READER })) {
    renderStack({ animate: false });
    announce('That note could not be opened.');
    return;
  }

  if (alreadyHome) {
    // Back from an account view to the home note that is already in the stack.
    enterReaderView({ ids: [defaultId] });
    putHomeOnTop();
    return;
  }

  enterReaderView({ ids: [defaultId], focusElement: true, animate: true });
}

function onDocumentClick(event) {
  // Leave modified and non-primary clicks to the browser so "open in new tab"
  // still receives the canonical single-note URL from the href.
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  if (!(event.target instanceof Element)) return;

  const closable = event.target.closest('[data-close-index]');
  if (closable) {
    event.preventDefault();
    closePane(Number(closable.dataset.closeIndex));
    return;
  }

  // The account region's own local navigation. Modified and non-primary clicks
  // already returned above, so those keep the href the browser would follow.
  const viewLink = event.target.closest('[data-account-view]');
  if (viewLink) {
    event.preventDefault();
    goToView(viewLink.dataset.accountView);
    return;
  }

  const backLink = event.target.closest('[data-account-back]');
  if (backLink) {
    event.preventDefault();
    goToReader();
    return;
  }

  const anchor = event.target.closest('a');
  if (!anchor || anchor.dataset.externalBrowser === 'true') return;
  if (anchor.dataset.designUrl && anchor.closest('.note-content')) {
    event.preventDefault();
    openDesign(anchor);
    return;
  }

  const id = anchor.dataset.noteId;
  if (!id) {
    // A same-note heading link (`[[#heading]]`) stays inside its pane.
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#') && href.length > 1) {
      const pane = anchor.closest('.pane');
      if (pane) {
        event.preventDefault();
        scrollToHeading(pane, safeDecode(href.slice(1)), scrollBehavior());
      }
    }
    return;
  }

  event.preventDefault();
  const pane = anchor.closest('.pane');
  const index = pane ? Number(pane.dataset.index) : state.stack.length - 1;
  navigateFromPane(index, id, anchor.dataset.heading || null);
}

function onPopState() {
  dismissPreview();
  closeSearch();
  // Boot, Back/Forward and URL normalisation all go through one reconciliation,
  // so the region and the stack can never disagree with the address bar.
  reconcileRoute();
}

/* ---------------------------------------------------------------- search --- */

function isMac() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
}

function openSearchPopover() {
  if (!search.open) {
    search.open = true;
    els.results.hidden = false;
    els.input.setAttribute('aria-expanded', 'true');
  }
}

function closeSearch() {
  // Invalidate any request that is still in flight, so a late response cannot
  // reopen a popover the reader already dismissed.
  search.generation += 1;
  search.pending = false;
  if (search.timer) {
    window.clearTimeout(search.timer);
    search.timer = 0;
  }
  if (!search.open) return;
  search.open = false;
  els.results.hidden = true;
  els.input.setAttribute('aria-expanded', 'false');
  els.input.removeAttribute('aria-activedescendant');
}

function focusSearch() {
  if (!state.ready || els.input.disabled) return;
  els.input.focus();
  els.input.select();
}

function syncSearchActive() {
  const options = [...els.results.querySelectorAll('[role="option"]')];
  options.forEach((option, index) => {
    const active = index === search.active;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (search.active >= 0 && options[search.active]) {
    els.input.setAttribute('aria-activedescendant', options[search.active].id);
    options[search.active].scrollIntoView({ block: 'nearest' });
  } else {
    els.input.removeAttribute('aria-activedescendant');
  }
}

function showSearchResults(query, results) {
  search.results = results;
  search.active = results.length ? 0 : -1;
  search.pending = false;
  els.results.replaceChildren();

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.setAttribute('role', 'status');
    empty.textContent = `No matches for “${query}”.`;
    els.results.append(empty);
  } else {
    results.forEach((result, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'search-result';
      option.id = `search-result-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', index === 0 ? 'true' : 'false');

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = result.title || friendlyName(result.id);

      const snippet = document.createElement('span');
      snippet.className = 'search-result-snippet';
      snippet.textContent = result.snippet || '';

      option.append(title, snippet);
      // Keep focus in the input; activating an option must not blur the field
      // and race the popover closed before the click lands.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => chooseSearchResult(index));
      els.results.append(option);
    });
  }

  openSearchPopover();
  syncSearchActive();
}

function showSearchMessage(message) {
  search.results = [];
  search.active = -1;
  search.pending = false;
  els.results.replaceChildren();
  const note = document.createElement('div');
  note.className = 'search-empty';
  note.setAttribute('role', 'status');
  note.textContent = message;
  els.results.append(note);
  openSearchPopover();
}

/**
 * Drop the previous query's results the moment the field changes. Leaving them
 * on screen invites Enter to open a note the field no longer says.
 */
function markSearchPending(query) {
  search.results = [];
  search.active = -1;
  search.pending = true;
  els.input.removeAttribute('aria-activedescendant');
  const note = document.createElement('div');
  note.className = 'search-empty search-pending';
  note.setAttribute('role', 'status');
  note.textContent = `Searching for “${query.trim()}”…`;
  els.results.replaceChildren(note);
  openSearchPopover();
}

function resetSearch() {
  search.results = [];
  search.active = -1;
  search.pending = false;
  els.results.replaceChildren();
  closeSearch();
}

function chooseSearchResult(index) {
  if (search.pending) return;
  const result = search.results[index];
  if (!result) return;
  closeSearch();
  navigateFromPane(state.stack.length - 1, result.id, null);
}

async function runSearch(query, generation) {
  try {
    const response = await fetch(`/api/search?${queryString({ q: query, limit: 8 })}`, {
      headers: { accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (generation !== search.generation) return;
    if (!response.ok) throw new Error(data?.error?.message || 'Search failed');
    showSearchResults(query, Array.isArray(data?.results) ? data.results : []);
  } catch {
    if (generation !== search.generation) return;
    showSearchMessage('Search is unavailable right now.');
  }
}

/* --------------------------------------------------------------- preview --- */

function placePreview(rect) {
  const width = 500;
  const height = 400;
  const gap = 12;
  const pad = 8;

  if (window.innerHeight < height + pad * 2 || window.innerWidth < width + pad * 2) return null;

  const top = Math.min(Math.max(rect.top - 16, pad), window.innerHeight - height - pad);

  // Prefer the right side, fall back to the left, and only then above/below.
  // The card must never sit on top of the link it describes.
  if (rect.right + gap + width <= window.innerWidth - pad) {
    return { left: rect.right + gap, top };
  }
  if (rect.left - gap - width >= pad) {
    return { left: rect.left - gap - width, top };
  }

  const left = Math.min(Math.max(rect.left, pad), window.innerWidth - width - pad);
  if (rect.bottom + gap + height <= window.innerHeight - pad) {
    return { left, top: rect.bottom + gap };
  }
  if (rect.top - gap - height >= pad) {
    return { left, top: rect.top - gap - height };
  }
  return null;
}

async function fillPreview(id, generation) {
  els.previewContent.innerHTML = '<p class="preview-loading">Loading…</p>';
  try {
    const note = await getNote(id);
    if (generation !== preview.generation || !preview.visible) return;
    els.previewContent.innerHTML = note.html;
  } catch {
    if (generation !== preview.generation) return;
    dismissPreview();
  }
}

function showPreview(link) {
  if (!state.previewEnabled || !desktopPointer.matches) return;
  const pane = link.closest('.pane');
  if (!pane) return;

  const id = link.dataset.noteId;
  if (!id || id === pane.dataset.noteId) return;
  // A demo pane is a view, not a note: it has nothing to preview.
  if (isDemoPaneId(id)) return;

  const rect = link.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const place = placePreview(rect);
  if (!place) return;

  els.preview.style.left = `${Math.round(place.left)}px`;
  els.preview.style.top = `${Math.round(place.top)}px`;
  els.preview.hidden = false;
  preview.visible = true;
  const generation = ++preview.generation;
  fillPreview(id, generation);
}

function dismissPreview() {
  if (preview.timer) {
    window.clearTimeout(preview.timer);
    preview.timer = 0;
  }
  preview.generation += 1;
  preview.visible = false;
  els.preview.hidden = true;
  els.previewContent.replaceChildren();
}

function openDesign(link) {
  const url = link.dataset.designUrl;
  if (!url) return;
  const pane = link.closest('.pane');
  const index = pane ? Number(pane.dataset.index) : state.stack.length - 1;
  navigateFromPane(index, designPaneId(url));
}

/** Navigate only from a currently mounted direct iframe to its readable context. */
async function handleDesignContextMessage(event) {
  const request = designContextRequest(event.data);
  if (!state.ready || !request || !isValidNoteId(request.noteId)) return;
  const pane = state.panes.find(p =>
    p.querySelector('.design-pane-viewport > iframe')?.contentWindow === event.source);
  if (!pane) return;
  const frame = pane.querySelector('.design-pane-viewport > iframe');
  const designURL = designUrlFromPaneId(pane.dataset.noteId);
  if (!frame || !designURL) return;
  try {
    const note = await getNote(request.noteId); // Same scope/privacy gate as ordinary note links.
    if (!pane.isConnected || !frame.isConnected || frame.contentWindow !== event.source) return;
    if (designUrlFromPaneId(pane.dataset.noteId) !== designURL) return;
    const heading = designContextHeading(note.html, designURL, request.heading);
    if (heading === null) return;
    const index = state.panes.indexOf(pane);
    if (index !== -1) navigateFromPane(index, request.noteId, heading);
  } catch { /* Missing/private/out-of-scope notes cannot become message targets. */ }
}

/* ------------------------------------------------------------- the demo --- */

/**
 * The participation demo is additive and optional. It boots beside the reader,
 * never in front of it: if the browser refuses local storage, the notes still
 * load and the account pane explains why nothing can be saved.
 */
let demo = null;
let demoStore = null;
let tracker = null;
/** Resolves once the runtime store has been chosen (or failed) at boot. */
let demoBoot = null;
/** Notes that rendered before the runtime store was chosen. */
const pendingDemoDecorations = new Map();
/** Which account measured reading time should be credited to, at flush time. */
let trackedAccountId = null;
/** True while a reset is in progress: no new statistics write may be issued. */
let trackingPaused = false;
/** Already-issued statistics writes, so a reset can wait for them to land. */
const trackingWrites = new Set();
let trackingFailureReported = false;

/**
 * Observe one statistics write. The notes must keep working when storage does,
 * so a failure is reported once through the reader's existing status line
 * rather than thrown, and never silently dropped.
 */
function trackWrite(promise) {
  if (!promise) return;
  const observed = promise.catch(() => {
    if (trackingFailureReported) return;
    trackingFailureReported = true;
    announce('Reading statistics could not be saved in this browser.');
  });
  trackingWrites.add(observed);
  observed.then(() => trackingWrites.delete(observed));
}

/** Wait for every statistics write already issued to settle. */
async function drainTrackingWrites() {
  while (trackingWrites.size) {
    await Promise.allSettled([...trackingWrites]);
  }
}

/**
 * Reading time is paused while a demo dialog owns the screen and while an
 * account region is showing. The two conditions are combined rather than
 * layered, so closing a dialog cannot resume tracking behind a hidden reader.
 */
function syncTrackingPause() {
  tracker?.setPaused(Boolean(demo?.hasOpenDialog()) || isAccountView(state.view));
}

/** Re-render the account region only when it is the region on screen. */
function refreshActiveAccountView() {
  if (!isAccountView(state.view)) return;
  renderAccountView(state.view, { focus: false });
}

/**
 * Keep the tracker in step with the demo session. The flush comes first and its
 * write is awaited before the account id is replaced, so signing out (or
 * switching accounts) neither loses nor misattributes the final stretch.
 */
async function syncDemoSession() {
  const next = demo?.session?.id ?? null;
  if (next !== trackedAccountId) {
    tracker?.flush();
    await drainTrackingWrites();
    trackedAccountId = next;
  }
  tracker?.setSignedIn(Boolean(next));
  // Admin navigation is authorized, and the account view shows the session.
  syncAccountLabel();
  syncAccountNav(state.view);
  refreshActiveAccountView();
}

async function initDemo() {
  try {
    demoStore = await loadRuntimeStore();
  } catch {
    return;
  }

  tracker = createReadingTracker({
    onView: (noteId) => {
      if (trackingPaused || !trackedAccountId) return;
      trackWrite(demoStore?.recordNoteView(trackedAccountId, noteId));
    },
    onTime: (ms) => {
      if (trackingPaused || !trackedAccountId) return;
      trackWrite(demoStore?.addActiveTime(trackedAccountId, ms));
    },
  });

  demo = createDemoUi({
    store: demoStore,
    announce,
    openView: (view) => goToView(view),
    changeRandom: (enabled) => {
      try {
        localStorage.setItem(RANDOM_KEY, enabled ? 'on' : 'off');
      } catch {
        /* this visit still honours the choice */
      }
      syncRandom();
    },
    changeReadingMode: (id) => {
      const { id: applied } = setReadingMode(id);
      const ids = currentReadingMode() === 'page' ? state.stack.slice(-1) : state.stack;
      if (!ids.length) return applied;
      // Keep the URL and the visible stack in step with the new layout.
      writeRouteUrl(ids, { view: state.view, hash: state.routeHash ?? '', replace: true });
      state.stack = ids;
      if (state.view === VIEW_READER) renderStack({ animate: false });
      syncAccountNav(state.view);
      return applied;
    },
    // Statistics must include the stretch the reader just finished, so settle
    // the tracker and let its write land before a demo view reads them.
    settleTracking: async () => {
      tracker?.settle();
      await drainTrackingWrites();
    },
    beforeReset: async () => {
      trackingPaused = true;
      tracker?.discard();
      await drainTrackingWrites();
    },
    afterReset: ({ ok } = {}) => {
      trackingPaused = false;
      trackingFailureReported = false;
      // A successful reset deleted the account those writes belonged to; the
      // session change that follows must not flush into it.
      if (ok) trackedAccountId = null;
    },
  });

  demo.onChange(syncDemoSession);
  demo.onDialogChange(syncTrackingPause);
  tracker.setVisible(document.visibilityState !== 'hidden');
  tracker.start();
  tracker.setActiveNote(isAccountView(state.view) ? null : mostVisiblePaneId());

  // Notes can render while the runtime config is still loading. Give each one
  // its activity control and the page view it earned, without blocking notes.
  for (const [article, entry] of pendingDemoDecorations) {
    if (!article.isConnected) continue;
    demo.decorateArticle(article, entry.note);
    if (entry.rendered) tracker.markRendered(entry.id);
  }
  pendingDemoDecorations.clear();

  // Deliberately not awaited: a storage failure must not stop the notes loading.
  demo.init().then(syncDemoSession).catch(() => {});
}

/**
 * The header's User info entry opens the full-page account region. It is a
 * region of the same page, not a pane, so it is reachable even when the notes
 * index failed to load.
 */
function openUserInfo() {
  goToView(VIEW_ACCOUNT);
}

/* ------------------------------------------------------------- listeners --- */

window.addEventListener('message', handleDesignContextMessage);

els.title.addEventListener('click', (event) => {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  const aboutId = state.bootstrap?.aboutNoteId;
  if (state.ready && aboutId) {
    navigateFromPane(state.stack.length - 1, aboutId, null);
    return;
  }
  goHome();
});

els.random.addEventListener('click', async () => {
  if (!state.ready) return;
  els.random.disabled = true;
  try {
    const current = state.stack[state.stack.length - 1] || '';
    const response = await fetch(`/api/random?not=${encodeURIComponent(current)}`, {
      headers: { accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.id) {
      throw new Error(data?.error?.message || 'No random note');
    }
    navigateFromPane(state.stack.length - 1, data.id, null);
  } catch {
    announce('Could not pick a random note.');
  } finally {
    els.random.disabled = false;
  }
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Enter before this query's results have landed must not reuse the old list.
  if (search.pending) return;
  if (search.open && search.results.length) {
    chooseSearchResult(search.active >= 0 ? search.active : 0);
  }
});

els.input.addEventListener('input', () => {
  const query = els.input.value;
  const generation = ++search.generation;
  window.clearTimeout(search.timer);
  search.timer = 0;

  if (!query.trim()) {
    resetSearch();
    return;
  }

  // The listed results belong to the previous query; retire them now.
  markSearchPending(query);

  // Debounce the request, never the field. Typing stays synchronous; a stale
  // response is discarded by comparing generations.
  search.timer = window.setTimeout(() => {
    search.timer = 0;
    runSearch(query, generation);
  }, 120);
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!search.open || !search.results.length) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const count = search.results.length;
    search.active = (search.active + direction + count) % count;
    syncSearchActive();
    return;
  }

  if (event.key === 'Enter') {
    if (search.pending) {
      event.preventDefault();
      return;
    }
    if (search.open && search.results.length) {
      event.preventDefault();
      chooseSearchResult(search.active >= 0 ? search.active : 0);
    }
  }
});

els.form.addEventListener('focusout', (event) => {
  if (!els.form.contains(event.relatedTarget)) closeSearch();
});

document.addEventListener('pointerdown', (event) => {
  if (search.open && event.target instanceof Node && !els.form.contains(event.target)) {
    closeSearch();
  }
});

document.addEventListener('keydown', (event) => {
  // A native modal dialog owns the keyboard while it is open. The reader's
  // shortcuts must not pull focus out of a form the reader is filling in.
  if (demo?.hasOpenDialog()) return;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'k') {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (event.key === 'Escape') {
    if (search.open) {
      event.preventDefault();
      closeSearch();
      // Dismiss means leave the field, not just hide the results: Escape is how
      // a reader gets back to the notes without reaching for the mouse.
      els.input.blur();
      return;
    }
    if (document.activeElement === els.input) {
      els.input.blur();
      return;
    }
    dismissPreview();
  }
});

document.addEventListener('click', onDocumentClick);
window.addEventListener('popstate', onPopState);
window.addEventListener('resize', () => {
  scheduleGeometry();
  dismissPreview();
});

document.addEventListener('visibilitychange', () => {
  tracker?.setVisible(document.visibilityState !== 'hidden');
  // Hand over what was measured before the tab is frozen or closed.
  if (document.visibilityState === 'hidden') tracker?.flush();
});

// Any real interaction is the reader being present; idleness is the absence of
// all of these for a while. Passive: none of this changes the gesture.
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(type, () => tracker?.noteInteraction(), { passive: true });
}

els.settings.addEventListener('click', () => goToView(VIEW_SETTINGS));
els.login.addEventListener('click', openUserInfo);

// Crossing the breakpoint changes which sheets have a box at all. Widening
// gives the row horizontal geometry back, so put the newest pane in view
// instead of leaving the stack scrolled to its leftmost pane.
narrowLayout.addEventListener('change', (event) => {
  scheduleGeometry();
  if (event.matches || isAccountView(state.view)) return;
  window.requestAnimationFrame(() => {
    if (!state.panes.length) return;
    scheduleGeometry();
    centerPane(state.panes.length - 1, 'auto');
  });
});

els.stack.addEventListener('scroll', scheduleGeometry, { passive: true })

// Horizontal intent belongs to the row, not the pane. A pane's body is its own
// vertical scroller (and its horizontal overflow is hidden), so it swallows the
// horizontal part of a trackpad swipe before the stack ever sees it. Map the
// gesture here instead: a sideways swipe, or shift+wheel on a mouse, moves the
// stack; plain vertical wheel still scrolls the note under the pointer.
els.stack.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey) return // pinch-zoom
    // Some platforms already swap the axis when shift is held, so accept either.
    const sideways = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX
    const vertical = event.shiftKey ? 0 : event.deltaY
    if (!sideways || Math.abs(sideways) <= Math.abs(vertical)) return

    const max = els.stack.scrollWidth - els.stack.clientWidth
    if (max <= 0) return
    const next = Math.max(0, Math.min(max, els.stack.scrollLeft + sideways))
    if (next === els.stack.scrollLeft) return

    event.preventDefault()
    els.stack.scrollLeft = next
    scheduleGeometry()
  },
  { passive: false },
);

// Scroll events do not bubble; capture lets one listener catch the stack and
// every pane's own vertical scroller.
document.addEventListener(
  'scroll',
  () => {
    if (preview.visible || preview.timer) dismissPreview();
  },
  { capture: true, passive: true },
);

document.addEventListener('mouseover', (event) => {
  if (!state.previewEnabled || !desktopPointer.matches) return;
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a[data-note-id]');
  if (!link || !link.closest('.pane')) return;
  if (event.relatedTarget && link.contains(event.relatedTarget)) return;

  if (preview.timer) window.clearTimeout(preview.timer);
  preview.timer = window.setTimeout(() => {
    preview.timer = 0;
    showPreview(link);
  }, 250);
});

document.addEventListener('mouseout', (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a[data-note-id]');
  if (!link) return;
  if (event.relatedTarget && link.contains(event.relatedTarget)) return;
  dismissPreview();
});

els.key.textContent = isMac() ? '⌘K' : 'Ctrl K';
syncAccountLabel();
// The inline script in the shell has already applied the saved preset; this
// re-reads it so the module's in-memory choice matches what is on screen.
initAppearance();
initReadingMode();
demoBoot = initDemo();
boot();
