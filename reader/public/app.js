/**
 * stacked-notes — the browser reader.
 *
 * The URL is the state:
 *
 *   /<first-note>?stackedNotes=<second>&stackedNotes=<third>
 *
 * The path is the leftmost pane; each repeated query parameter is a pane to its
 * right. Everything else (fetched note HTML, backlinks, search, previews) is
 * derived from that stack. Nothing here writes to the vault.
 *
 * No build step and no dependencies: this file is loaded directly as a module.
 */

import { fetchStatic as fetch } from './static-api.js';
import { wikipediaArticle } from './wikipedia.js';
import { designPaneLayout, designContextRequest, designContextHeading } from './design-context.js';

const els = {
  title: document.getElementById('app-title'),
  about: document.getElementById('about-link'),
  random: document.getElementById('random-button'),
  form: document.getElementById('search-form'),
  input: document.getElementById('search-input'),
  key: document.getElementById('search-key'),
  results: document.getElementById('search-results'),
  stack: document.getElementById('stack'),
  preview: document.getElementById('preview'),
  previewContent: document.getElementById('preview-content'),
  status: document.getElementById('status'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrowLayout = window.matchMedia('(max-width: 800px)');
const desktopPointer = window.matchMedia('(min-width: 801px) and (hover: hover) and (pointer: fine)');

const state = {
  bootstrap: null,
  stack: [],
  panes: [],
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

function isValidPaneId(id) {
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

function stackHref(ids) {
  const valid = ids.filter(isValidPaneId);
  if (!valid.length) return '/';
  const rest = valid
    .slice(1)
    .map((id) => `stackedNotes=${encodeURIComponent(id)}`)
    .join('&');
  return noteHref(valid[0]) + (rest ? `&${rest}` : '');
}

/**
 * Read the stack out of the URL, dropping any id that is not a valid note id.
 * Returns whether anything had to be dropped so the caller can normalise the
 * URL with `replaceState` (never `pushState`: the reader did not navigate).
 */
function stackFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const first = params.get('note');
  const candidates = first ? [first, ...params.getAll('stackedNotes')] : [];

  const ids = [];
  let invalid = false;
  for (const id of candidates) {
    if (isValidPaneId(id)) ids.push(id);
    else invalid = true;
  }
  return { ids, invalid };
}

/**
 * Write the URL for a stack, never throwing. A browser can refuse a history
 * write (a SecurityError for a URL it reads as another origin, for instance);
 * the caller must then put its state back so the DOM and the URL still agree.
 */
function writeStackUrl(ids, { replace = false } = {}) {
  // Never write a URL that does not describe the whole stack: a caller that
  // hands us a junk id gets a refusal (and restores its state) instead of a
  // silently shorter URL that disagrees with the panes on screen.
  if (!ids.every(isValidPaneId)) return false;
  const href = stackHref(ids);
  try {
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the stack the URL describes, normalising invalid ids and falling
 * back to the default note when the URL names nothing usable.
 */
function stackFromUrl() {
  const located = stackFromLocation();
  let ids = located.ids;
  let needsReplace = located.invalid;

  if (!ids.length) {
    const defaultId = state.bootstrap?.defaultNoteId;
    if (!defaultId) {
      if (needsReplace) writeStackUrl([], { replace: true });
      return { ids: [], empty: true };
    }
    ids = [defaultId];
    needsReplace = true;
  }

  if (needsReplace) {
    // Best effort: if the browser refuses even this same-origin replace, the
    // valid stack is still what gets rendered, so nothing is built from a junk
    // id; the stale segment simply stays in the address bar.
    writeStackUrl(ids, { replace: true });
  }
  return { ids, empty: false };
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
  return state.bootstrap?.app?.title || 'stacked-notes';
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
    renderBootstrapError(error);
    return;
  }

  state.bootstrap = bootstrap;
  state.ready = true;
  applyChrome(bootstrap);

  const located = stackFromUrl();
  if (located.empty) {
    state.stack = [];
    renderEmptyVault();
    return;
  }

  state.stack = located.ids;
  renderStack({ animate: false });
}

function applyChrome(bootstrap) {
  els.title.textContent = appTitle();
  document.title = appTitle();

  if (bootstrap.aboutNoteId) {
    els.about.href = noteHref(bootstrap.aboutNoteId);
    els.about.dataset.noteId = bootstrap.aboutNoteId;
    els.about.hidden = false;
  } else {
    els.about.hidden = true;
  }

  els.random.hidden = bootstrap.features?.random === false;
  const searchEnabled = bootstrap.features?.search !== false;
  els.form.hidden = !searchEnabled;
  els.input.disabled = !searchEnabled;
  state.previewEnabled = bootstrap.features?.preview !== false;
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
function renderStack({ focusElement = false, heading = null, animate = true } = {}) {
  const token = ++renderToken;
  dismissPreview();
  closeSearch();

  els.stack.replaceChildren();
  state.panes = [];

  state.stack.forEach((id, index) => {
    const pane = buildPane(id, index);
    els.stack.append(pane);
    state.panes.push(pane);
    fillPane(pane, id, index, token, {
      heading: index === state.stack.length - 1 ? heading : null,
      animate,
    });
  });

  const last = state.stack[state.stack.length - 1];
  document.title = last ? `${friendlyName(last)} · ${appTitle()}` : appTitle();
  scheduleGeometry();

  if (state.panes.length) {
    const index = state.panes.length - 1;
    // Wait for the browser to lay the new panes out before measuring them.
    window.requestAnimationFrame(() => {
      if (token !== renderToken) return;
      centerPane(index, animate ? scrollBehavior() : 'auto');
      if (focusElement) state.panes[index]?.focus({ preventScroll: true });
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
  const backlinks = document.createElement('footer');
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
  if (visible && wasVisible === false) restorePaneScroll(pane);
}

async function fillPane(pane, id, index, token, { heading, animate }) {
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
    if (note.source === 'wikipedia') renderWikipediaSource(article, note.sourceUrl);
    renderBacklinks(backlinks, note);
    applyNoteTitle(pane, spineTitle, note.title, index);

    // The content (and so the scrollable height) is only real now.
    restorePaneScroll(pane);

    // A canonical `/<note>#heading` URL (cmd-click, reload) should land on the
    // same heading a normal click would. In-app navigation clears the hash.
    const fragment = index === state.stack.length - 1 && !heading
      ? safeDecode(window.location.hash.slice(1))
      : '';
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
  footer.hidden = note.source === 'wikipedia';
  if (footer.hidden) return;

  const header = document.createElement('div');
  header.className = 'backlinks-header';
  const heading = document.createElement('h2');
  heading.textContent = 'Links to this note';
  header.append(heading);

  if (note.obsidianUrl?.startsWith('obsidian://open?')) {
    const editLink = document.createElement('a');
    editLink.className = 'obsidian-link';
    editLink.href = note.obsidianUrl;
    editLink.textContent = 'Open in Obsidian';
    editLink.title = 'Open this note in Obsidian to edit it';
    header.append(editLink);
  }
  footer.append(header);

  const backlinks = Array.isArray(note.backlinks) ? note.backlinks : [];
  if (!backlinks.length) {
    const empty = document.createElement('p');
    empty.className = 'backlinks-empty';
    empty.textContent = 'No other note links here.';
    footer.append(empty);
    return;
  }

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

    const id = document.createElement('span');
    id.className = 'backlink-id';
    id.textContent = backlink.id;

    card.append(title, id);
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
  state.panes = [];
  els.stack.replaceChildren();
  dismissPreview();
  closeSearch();
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
    // Already open: reveal it without adding an entry to history.
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
  const previous = state.stack;
  const next = state.stack.slice(0, safeIndex + 1);
  next.push(id);

  if (!writeStackUrl(next)) {
    // The browser refused the URL. Put the old stack back rather than showing
    // panes the address bar does not describe.
    state.stack = previous;
    renderStack({ animate: false });
    announce('That note could not be opened.');
    return;
  }

  state.stack = next;
  renderStack({ focusElement: true, heading, animate: true });
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
  if (!state.ready || state.stack.length <= 1) return;
  if (index < 0 || index >= state.stack.length) return;

  const previous = state.stack;
  const closed = previous[index];
  const next = previous.filter((_, at) => at !== index);

  if (!writeStackUrl(next)) {
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

  if (state.stack.length === 1 && state.stack[0] === defaultId) {
    const sheet = state.panes[0]?.querySelector('.pane-sheet');
    sheet?.scrollTo({ top: 0, behavior: scrollBehavior() });
    centerPane(0, scrollBehavior());
    state.panes[0]?.focus({ preventScroll: true });
    return;
  }

  const previous = state.stack;
  if (!writeStackUrl([defaultId])) {
    state.stack = previous;
    renderStack({ animate: false });
    announce('That note could not be opened.');
    return;
  }

  state.stack = [defaultId];
  renderStack({ focusElement: true, animate: true });
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
  if (!state.bootstrap) return;
  dismissPreview();
  closeSearch();

  const located = stackFromUrl();
  if (located.empty) {
    state.stack = [];
    renderEmptyVault();
    return;
  }

  state.stack = located.ids;
  renderStack({ animate: false });
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

// Crossing the breakpoint changes which sheets have a box at all. Widening
// gives the row horizontal geometry back, so put the newest pane in view
// instead of leaving the stack scrolled to its leftmost pane.
narrowLayout.addEventListener('change', (event) => {
  scheduleGeometry();
  if (event.matches) return;
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
boot();
