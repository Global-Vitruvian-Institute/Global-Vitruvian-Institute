/**
 * demo-ui.js — the account and admin views, the demo dialogs, and evidence.
 *
 * Two rules shape everything here:
 *
 *  1. Nothing the reader typed or uploaded is ever parsed as markup. Reflections
 *     and feedback go in through `textContent`; evidence is either previewed as
 *     an allow-listed image or handed over as a download whose blob type is
 *     deliberately `application/octet-stream`, so a copied blob URL cannot be
 *     rendered as HTML or SVG.
 *  2. The demo is a guest in the reader. It renders into the full-page account
 *     region, it owns no global navigation, and every object URL it creates is
 *     revoked when the region changes or the reader returns to the notes.
 */
import {
  DEMO_ADMIN_EMAIL,
  DEMO_DISCLOSURE,
  DEMO_LIMITS,
  DEMO_VERIFICATION_CODE,
  canPreviewEvidence,
  countByStatus,
  formatBytes,
  formatDuration,
  formatTimestamp,
  isAdminEmail,
  statusLabel,
  SUBMISSION_STATUSES,
  summarizeStats,
  validateEmail,
  validateFeedback,
  validateSubmissionInput,
  validateVerificationCode,
} from './demo-model.js';
import { APPEARANCES, appearanceLabel, currentAppearance, setAppearance } from './appearance.js';
import { READING_MODES, currentReadingMode, readingModeLabel, setReadingMode } from './reading.js';
import { addGuestEntry, claimGuestEntry, guestEntryFor, readGuestEntries, removeGuestEntries, upsertGuestEntry } from './guest.js';
import { activityMetadata } from './activity-catalog.js';
import { createActivityCollection } from './activity-collection.js';

const EVIDENCE_ACCEPT = [
  ...['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
  'application/pdf', 'text/plain',
].join(',');

let dialogCounter = 0;

/**
 * A per-host render generation. The reader's region token is shared by every
 * render, so it cannot tell two overlapping loads of the *same* host apart: this
 * adds the missing per-host ordering, and binds each render to the session it
 * was started for. A render that is no longer current must not build, commit or
 * clean up after a newer one.
 */
export function createPaneRenderGuard() {
  const generations = new WeakMap();
  return {
    begin(pane, sessionId = null) {
      const generation = (generations.get(pane) ?? 0) + 1;
      generations.set(pane, generation);
      return {
        generation,
        isCurrent: (currentSessionId = sessionId) =>
          generation === generations.get(pane) && currentSessionId === sessionId,
      };
    },
  };
}

function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function button(label, className = '') {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/** A labelled control with a hint, an associated error, and aria-invalid. */
function buildField({ id, labelText, type = 'text', hint = null, rows = 0, autocomplete = 'off', maxLength = null }) {
  const wrap = el('div', 'demo-field');
  const label = el('label', 'demo-label', labelText);
  label.htmlFor = id;

  const control = rows ? document.createElement('textarea') : document.createElement('input');
  control.id = id;
  control.className = 'demo-control';
  if (rows) control.rows = rows;
  else {
    control.type = type;
    control.autocomplete = autocomplete;
  }
  if (maxLength) control.maxLength = maxLength;

  const described = [];
  let hintEl = null;
  if (hint) {
    hintEl = el('p', 'demo-hint', hint);
    hintEl.id = `${id}-hint`;
    described.push(hintEl.id);
  }
  const error = el('p', 'demo-error');
  error.id = `${id}-error`;
  error.hidden = true;
  error.setAttribute('role', 'alert');
  described.push(error.id);
  control.setAttribute('aria-describedby', described.join(' '));

  const setError = (message) => {
    error.textContent = message ?? '';
    error.hidden = !message;
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  };

  wrap.append(label, control);
  if (hintEl) wrap.append(hintEl);
  wrap.append(error);
  return { wrap, control, error, setError };
}

function section(heading) {
  const node = el('section', 'demo-section');
  node.append(el('h2', 'demo-section-title', heading));
  return node;
}

function definitionList(rows) {
  const list = el('ul', 'demo-facts');
  for (const [label, value] of rows) {
    const item = el('li', 'demo-fact');
    item.append(el('span', 'demo-fact-label', label), el('span', 'demo-fact-value', value));
    list.append(item);
  }
  return list;
}

/* --------------------------------------------- loading shell and scholarship --- */

/** The heading each account region carries, shared with the loading shell. */
const VIEW_HEADINGS = Object.freeze({ account: 'User', settings: 'Settings', admin: 'Admin' });

function viewHeading(view) {
  return VIEW_HEADINGS[view] ?? VIEW_HEADINGS.account;
}

/** A quiet, non-focusable placeholder bar. Never a number, never a control. */
function loadingBar(className = 'account-loading-bar') {
  const bar = el('div', className);
  bar.setAttribute('aria-hidden', 'true');
  return bar;
}

/** A static section heading with neutral skeleton geometry under it. */
function loadingSection(title, lines, className = '') {
  const node = el('section', `demo-section account-loading-section ${className}`.trim());
  node.append(el('h2', 'demo-section-title account-loading-heading', title));
  const bars = el('div', 'account-loading-bars');
  bars.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < lines; index += 1) bars.append(loadingBar());
  node.append(bars);
  return node;
}

/**
 * The account region's first paint, usable before the runtime store is chosen.
 * It needs no store and no session: the view's own headings and quiet skeleton
 * bars, so the page never opens empty and never guesses at the reader's data.
 * `aria-busy` marks the region as still coming, and one visually-hidden status
 * announces it exactly once.
 */
export function createAccountLoadingView(view = 'account', { session = null } = {}) {
  const resolved = Object.hasOwn(VIEW_HEADINGS, view) ? view : 'account';
  const root = el('div', 'account-loading');
  root.dataset.accountLoading = resolved;
  root.setAttribute('aria-busy', 'true');

  const status = el('p', 'visually-hidden account-loading-status', resolved === 'account'
    ? 'Loading activities'
    : `Loading ${resolved}`);
  status.setAttribute('role', 'status');
  root.append(status);

  const heading = el('h1', 'demo-title account-loading-title', viewHeading(resolved));
  heading.tabIndex = -1;
  root.append(heading);

  if (resolved === 'settings') {
    root.append(loadingSection('Reading', 2));
    root.append(loadingSection('Appearance', 2));
    root.append(loadingSection('Portfolio', 2));
    return root;
  }

  if (resolved === 'admin') {
    root.append(loadingSection('Participants', 3));
    root.append(loadingSection('Submissions', 4));
    return root;
  }

  // `session` is accepted so the caller can hand over what it already knows,
  // but nothing here reads it: no name, no count and no control is guessed.
  void session;
  root.append(loadingSection('Your collection', 3, 'account-loading-collection'));
  root.append(loadingSection('Activity history', 3));
  root.append(loadingSection('Pinned portfolio', 2));
  root.append(loadingSection('Your reading', 3));
  root.append(buildScholarshipSection());
  return root;
}

/**
 * The future scholarship. It is intent, not an available programme: a disabled
 * button and a plain status, with no dates, amounts, eligibility, application
 * or selection policy. Nothing here reads the reader's activity, and nothing
 * ties what they saved to an award.
 */
export function buildScholarshipSection() {
  const node = section('Vitruvian scholarship');
  node.dataset.accountSection = 'scholarship';
  node.append(el('p', 'demo-lede',
    'Planned enriching trips and shared experiences, with scholarship support so more young people can take part.'));
  const actions = el('div', 'demo-actions');
  const learn = button('Learn more', 'demo-button');
  learn.disabled = true;
  learn.setAttribute('aria-disabled', 'true');
  actions.append(learn, el('span', 'demo-status demo-status-plain', 'Coming soon'));
  node.append(actions);
  return node;
}

/** The small written labels for one saved activity: subject, format, optional second badge. */
function buildActivityTags(noteId) {
  const meta = activityMetadata(noteId);
  const list = el('ul', 'activity-tags');
  list.dataset.subject = meta.subjectId;
  list.dataset.format = meta.formatId;
  list.append(el('li', `activity-tag activity-tag-${meta.colorKey}`, meta.subjectLabel));
  list.append(el('li', 'activity-tag activity-tag-format', meta.formatLabel));
  return list;
}

/** Guest entries that no account has claimed. */
function unclaimedGuestEntries() {
  return readGuestEntries().filter((entry) => !entry.accountId);
}

/** One browser-local entry, shown the same way in every history list. */
function buildGuestRow(entry) {
  const item = el('li', 'demo-row demo-row-guest');
  const head = el('div', 'demo-row-head');
  head.append(el('h3', 'demo-row-title', entry.noteTitle || entry.noteId));
  head.append(el('span', 'demo-status demo-status-plain', 'Saved on this device'));
  item.append(head);
  item.append(el('p', 'demo-row-meta', formatTimestamp(entry.at)));
  item.append(buildActivityTags(entry.noteId));
  if (entry.reflection) item.append(el('p', 'demo-reflection', entry.reflection));
  return item;
}

/**
 * The Settings portfolio row. It states the current state and the future
 * option only: no storage, backend or privacy behaviour changes, and no data is
 * exposed.
 */
function buildPortfolioSettings() {
  const node = section('Portfolio');
  node.dataset.accountSection = 'portfolio';
  const row = el('div', 'demo-actions');
  row.append(el('span', 'demo-label', 'Public portfolio'));
  row.append(el('span', 'demo-status demo-status-plain', 'Private'));
  const makePublic = button('Make public', 'demo-button');
  makePublic.disabled = true;
  makePublic.setAttribute('aria-disabled', 'true');
  row.append(makePublic, el('span', 'demo-caption', 'Coming soon'));
  node.append(row);
  return node;
}

/* ------------------------------------------------------- activity log link --- */

/**
 * The account URL for one saved activity: the current note, stack and hash are
 * preserved, and only the region and the section to open are added, relative to
 * the current project path.
 */
function activityLogHref() {
  if (typeof window === 'undefined' || !window.location) {
    return './?view=account&section=activity-history';
  }
  const params = new URLSearchParams(window.location.search ?? '');
  params.set('view', 'account');
  params.set('section', 'activity-history');
  const query = params.toString();
  return `./${query ? `?${query}` : ''}${window.location.hash ?? ''}`;
}

/** The short post-save CTA. It starts hidden; the caller shows it. */
function buildActivityLogLink() {
  const link = el('a', 'activity-log-link', 'View activity log');
  link.href = activityLogHref();
  link.dataset.accountView = 'account';
  link.dataset.accountSection = 'activity-history';
  link.hidden = true;
  return link;
}

function refreshActivityLogLink(link) {
  if (link) link.href = activityLogHref();
}

/** Show the CTA beside a note's legacy `Log activity` control, idempotently. */
function showActivityLogLinkForNote(noteId) {
  const log = [...document.querySelectorAll('.demo-log-activity')]
    .find((node) => node.dataset.noteId === noteId);
  const wrap = log?.closest('.demo-activity-actions');
  if (!wrap) return null;
  let link = wrap.querySelector('.activity-log-link');
  if (!link) {
    link = buildActivityLogLink();
    wrap.append(link);
  }
  link.hidden = false;
  refreshActivityLogLink(link);
  return link;
}

/* --------------------------------------------------- collection lifecycle --- */

/**
 * One live pebble pile per host article. A rerender, a release or leaving the
 * region disposes the old pile first, so a detached view's animation frame or
 * observer cannot keep running. The settled layout cache is deliberately left
 * alone: it is keyed by scope id, and replaying a scope's own ids is what it is
 * for.
 */
const collectionByHost = new WeakMap();

function disposeCollection(host) {
  if (!host) return;
  const collection = collectionByHost.get(host);
  if (!collection) return;
  try {
    collection.dispose();
  } catch {
    /* the pile is already gone */
  }
  collectionByHost.delete(host);
}

function mountCollection(host, records, scopeId) {
  disposeCollection(host);
  const collection = createActivityCollection(records, { scopeId });
  collectionByHost.set(host, collection);
  return collection;
}

export function createDemoUi({
  store,
  announce = () => {},
  openView = () => {},
  changeReadingMode = null,
  changeRandom = null,
  settleTracking = async () => {},
  beforeReset = null,
  afterReset = null,
} = {}) {
  const remote = Boolean(store?.remote);
  const disclosureText = () => store?.disclosure || DEMO_DISCLOSURE;
  // In Supabase mode the database role is the only authority. The demo email
  // convention is a local-demo shortcut and must not leak into remote mode.
  const canReview = (account) => Boolean(account)
    && (account.role === 'admin'
      || account.role === 'reviewer'
      || (!remote && isAdminEmail(account.email)));

  let session = null;
  let ready = false;
  let failure = null;
  let initPromise = null;

  const dialogs = new Set();
  const changeListeners = new Set();
  const dialogListeners = new Set();
  const renderGuard = createPaneRenderGuard();
  /** Object URLs for one render of the account region, revoked with that render. */
  const paneUrls = new WeakMap();
  /** Inline activity controls by their `> [!activity]` section, for idempotent hydration. */
  const inlineByBlock = new WeakMap();
  let inlineCounter = 0;

  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          await store.open();
          await store.seedIfNeeded();
          session = await store.readSession();
          ready = true;
        } catch (error) {
          failure = error;
          ready = false;
          session = null;
        }
        return { ok: ready, error: failure };
      })();
    }
    const result = await initPromise;
    // A restored session may still be holding entries saved before sign-in, and
    // its controls were built while the session was still unknown.
    refreshInlineActivities();
    maybeMergeRestoredGuests();
    return result;
  }

  function notifyChange() {
    for (const listener of changeListeners) listener();
  }

  function setSession(account) {
    session = account ?? null;
    notifyChange();
    refreshInlineActivities();
  }

  function notifyDialogChange() {
    for (const listener of dialogListeners) listener();
  }

  function hasOpenDialog() {
    for (const entry of dialogs) if (entry.dialog.open) return true;
    return false;
  }

  /* ---------------------------------------------------------- object URLs --- */

  function createObjectUrl(pane, blob, generation) {
    if (typeof URL?.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(blob);
    const entry = paneUrls.get(pane);
    if (!entry || entry.generation !== generation) {
      paneUrls.set(pane, { generation, urls: [url] });
    } else {
      entry.urls.push(url);
    }
    return url;
  }

  /**
   * Revoke a host's object URLs. When `generation` is given, only that render's
   * URLs go: an older render finishing late must not revoke the evidence the
   * current view is showing.
   */
  function revokePaneUrls(pane, generation = null) {
    const entry = paneUrls.get(pane);
    if (!entry) return;
    if (generation !== null && entry.generation !== generation) return;
    for (const url of entry.urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
    paneUrls.delete(pane);
  }

  /**
   * Only allow-listed images keep their own type. Everything else is served as
   * opaque bytes, so an uploaded `.svg` or `.html` can never render as markup
   * even if its blob URL is opened directly.
   */
  function evidenceBlob(record) {
    const type = canPreviewEvidence(record.type) ? String(record.type).toLowerCase() : 'application/octet-stream';
    return new Blob([record.bytes], { type });
  }

  function buildEvidenceList(pane, records, generation) {
    if (!records.length) {
      const empty = el('p', 'demo-caption', 'No files attached.');
      return empty;
    }
    const list = el('ul', 'demo-evidence');
    for (const record of records) {
      const item = el('li', 'demo-evidence-item');
      const head = el('div', 'demo-evidence-head');
      head.append(el('span', 'demo-evidence-name', record.name));
      head.append(el('span', 'demo-evidence-meta', `${formatBytes(record.size)} · ${record.type || 'unknown type'}`));
      item.append(head);

      const url = createObjectUrl(pane, evidenceBlob(record), generation);
      if (url && canPreviewEvidence(record.type)) {
        const image = el('img', 'demo-evidence-image');
        image.src = url;
        image.alt = `Preview of ${record.name}`;
        image.loading = 'lazy';
        item.append(image);
      } else if (url) {
        const link = el('a', 'demo-evidence-download', `Download ${record.name}`);
        link.href = url;
        link.download = record.name;
        link.rel = 'noreferrer';
        item.append(link);
      } else {
        item.append(el('p', 'demo-caption', 'This browser cannot offer a download link.'));
      }
      list.append(item);
    }
    return list;
  }

  /* -------------------------------------------------------------- dialogs --- */

  function createDialog({ title, className = '' }) {
    const dialog = document.createElement('dialog');
    dialog.className = `demo-dialog ${className}`.trim();
    const headingId = `demo-dialog-title-${++dialogCounter}`;
    const heading = el('h2', 'demo-dialog-title', title);
    heading.id = headingId;
    dialog.setAttribute('aria-labelledby', headingId);
    const body = el('div', 'demo-dialog-body');
    dialog.append(heading, body);

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      dialog.remove();
      dialogs.delete(entry);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      notifyDialogChange();
    };

    const entry = { dialog, close, body };

    dialog.addEventListener('cancel', (event) => {
      // Escape dismisses; the native cancel event must not leave a stale node.
      event.preventDefault();
      close();
    });
    dialog.addEventListener('close', () => close());

    const host = document.getElementById('demo-dialog-host') ?? document.body;
    host.append(dialog);
    dialogs.add(entry);
    return entry;
  }

  function openDialog(entry, initialFocus) {
    if (typeof entry.dialog.showModal === 'function') entry.dialog.showModal();
    else entry.dialog.setAttribute('open', '');
    notifyDialogChange();
    const target = initialFocus?.() ?? null;
    if (target) target.focus({ preventScroll: true });
  }

  function closeDialogs() {
    for (const entry of [...dialogs]) entry.close();
  }

  /* ------------------------------------------------------------- sign in --- */

  function buildSignInForm({ idPrefix, onSignedIn }) {
    const form = el('form', 'demo-form demo-signin');
    form.noValidate = true;

    const emailField = buildField({
      id: `${idPrefix}-email`,
      labelText: 'Email address',
      type: 'email',
      autocomplete: 'email',
      hint: remote
        ? 'A sign-in link will be emailed to this address.'
        : 'Any address works. Nothing is sent, and there is no password.',
      maxLength: DEMO_LIMITS.maxEmailLength,
    });
    const emailStep = el('div', 'demo-signin-step');
    const continueButton = el('button', 'demo-button demo-button-primary', 'Continue');
    continueButton.type = 'submit';
    emailStep.append(emailField.wrap, continueButton);

    const codeField = buildField({
      id: `${idPrefix}-code`,
      labelText: 'Verification code',
      type: 'text',
      autocomplete: 'off',
      hint: remote ? 'Open the link from the email.' : 'Type the code shown above.',
    });
    const codeDisplay = el('p', 'demo-code');
    if (remote) {
      codeDisplay.textContent = 'Check this address for a sign-in email. Open its link on this device; the reader signs in automatically. No password is needed.';
      codeField.wrap.hidden = true;
    } else {
      codeDisplay.append('Demo verification code, shown on screen because this demo sends no email: ');
      codeDisplay.append(el('code', 'demo-code-value', DEMO_VERIFICATION_CODE));
    }
    const codeStep = el('div', 'demo-signin-step');
    codeStep.hidden = true;
    const codeActions = el('div', 'demo-dialog-actions');
    const backButton = button('Use a different email', 'demo-button');
    const signInButton = el('button', 'demo-button demo-button-primary', remote ? 'I opened the email link' : 'Sign in');
    signInButton.type = 'submit';
    codeActions.append(backButton, signInButton);
    codeStep.append(codeDisplay, codeField.wrap, codeActions);

    form.append(emailStep, codeStep);

    let step = 'email';
    let saving = false;

    backButton.addEventListener('click', () => {
      step = 'email';
      codeStep.hidden = true;
      emailStep.hidden = false;
      codeField.setError(null);
      emailField.control.focus();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;

      if (step === 'email') {
        const problem = validateEmail(emailField.control.value);
        emailField.setError(problem);
        if (problem) return;
        continueButton.disabled = true;
        try {
          await store.sendCode(emailField.control.value);
        } catch (error) {
          emailField.setError(error?.message ?? 'The code could not be sent.');
          continueButton.disabled = false;
          return;
        }
        continueButton.disabled = false;
        step = 'code';
        emailStep.hidden = true;
        codeStep.hidden = false;
        codeField.control.focus();
        announce(remote
          ? 'A one-time code was sent to that address.'
          : 'Demo verification code shown on screen. Enter it to finish signing in.');
        return;
      }

      if (remote) {
        saving = true;
        signInButton.disabled = true;
        try {
          const account = await store.readSession();
          if (!account) {
            codeField.wrap.hidden = false;
            codeField.setError('Open the link from the email on this device, then try again.');
            return;
          }
          setSession(account);
          // The magic-link path restores a session here rather than through the
          // dialog's demo branch, so the browser's saved entries move too.
          try {
            await mergeGuestEntries(account);
          } catch {
            /* the sign-in itself succeeded; the account view reports the rest */
          }
          announce(`Signed in as ${account.email}.`);
          onSignedIn?.(account);
        } catch (error) {
          codeField.wrap.hidden = false;
          codeField.setError(error?.message ?? 'Sign-in could not be completed.');
        } finally {
          saving = false;
          signInButton.disabled = false;
        }
        return;
      }

      const problem = validateVerificationCode(codeField.control.value);
      codeField.setError(problem);
      if (problem) return;

      saving = true;
      signInButton.disabled = true;
      try {
        const { account, created } = await store.signIn(emailField.control.value, codeField.control.value);
        await store.writeSession(account.id);
        setSession(account);
        try {
          await mergeGuestEntries(account);
        } catch {
          /* the sign-in itself succeeded; the account view reports the rest */
        }
        announce(created
          ? `Local demo account created for ${account.email}.`
          : `Signed in as ${account.email}.`);
        onSignedIn?.(account);
      } catch (error) {
        codeField.setError(error?.message ?? 'Sign-in failed in this browser.');
      } finally {
        saving = false;
        signInButton.disabled = false;
      }
    });

    return { form, focus: () => emailField.control.focus() };
  }

  function openSignInDialog({ onSignedIn, onGuest = null, intro } = {}) {
    const entry = createDialog({ title: 'Sign in to this browser', className: 'demo-dialog-signin' });
    if (intro) entry.body.append(el('p', 'demo-lede', intro));
    const built = buildSignInForm({
      idPrefix: `demo-dialog-signin-${dialogCounter}`,
      onSignedIn: (account) => {
        entry.close();
        onSignedIn?.(account);
      },
    });
    entry.body.append(built.form);
    if (onGuest) {
      const guest = button('Save on this device', 'demo-button');
      guest.addEventListener('click', () => {
        entry.close();
        onGuest();
      });
      entry.body.append(guest);
    }
    entry.body.append(el('p', 'demo-note', disclosureText()));
    openDialog(entry, built.focus);
    return entry;
  }

  /** A reflection-only entry that belongs to this browser, not an account. */
  function openGuestActivityDialog(note) {
    const entry = createDialog({ title: `Log activity — ${note.title || note.id}`, className: 'demo-dialog-activity' });
    entry.body.append(el('p', 'demo-lede',
      'Saved on this device for now. Sign in whenever you want to keep it in your portfolio.'));

    const form = el('form', 'demo-form');
    form.noValidate = true;
    const prefix = `demo-guest-activity-${dialogCounter}`;
    const reflectionField = buildField({
      id: `${prefix}-reflection`,
      labelText: 'Reflection',
      rows: 5,
      hint: 'Required. Files need an account.',
      maxLength: DEMO_LIMITS.maxReflectionLength,
    });
    const summary = el('p', 'demo-error demo-error-summary');
    summary.hidden = true;
    summary.setAttribute('role', 'alert');
    const actions = el('div', 'demo-dialog-actions');
    const cancel = button('Cancel', 'demo-button');
    const save = el('button', 'demo-button demo-button-primary', 'Save on this device');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(reflectionField.wrap, summary, actions);
    entry.body.append(form);
    cancel.addEventListener('click', () => entry.close());

    let saving = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (saving) return;
      const reflection = reflectionField.control.value.trim();
      if (!reflection) {
        reflectionField.setError('Add a short reflection.');
        return;
      }
      saving = true;
      save.disabled = true;
      const added = addGuestEntry({
        noteId: note.id,
        noteTitle: note.title || note.id,
        reflection,
      });
      if (!added) {
        summary.textContent = 'This browser would not store the entry.';
        summary.hidden = false;
        saving = false;
        save.disabled = false;
        return;
      }
      entry.close();
      announce('Saved on this device. Log in to keep it in your portfolio.');
      syncGuestMarker(note.id);
    });

    openDialog(entry, () => reflectionField.control.focus());
    return entry;
  }

  /** Add or remove the small “saved on this device” line under an activity. */
  function syncGuestMarker(noteId) {
    const log = [...document.querySelectorAll('.demo-log-activity')]
      .find((button) => button.dataset.noteId === noteId);
    const article = log?.closest('.note-content');
    if (!article) return;
    const saved = !session && Boolean(guestEntryFor(noteId));
    let marker = article.querySelector('.demo-guest-marker');
    if (!saved) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = el('p', 'demo-caption demo-guest-marker', 'Saved on this device. Log in to keep it.');
      log.after(marker);
    }
    // A restored browser-local entry also offers the log, so the reader can see
    // the pile without going through the dialog again.
    showActivityLogLinkForNote(noteId);
  }

  let guestMergePromise = null;
  let guestMergeAccountId = null;
  let restoredMergeChecked = false;
  let mergeFailure = null;

  function matchingResponse(rows, accountId, noteId, reflection) {
    return rows.find((row) => row.accountId === accountId && row.noteId === noteId
      && row.reflection === reflection && !row.evidence?.length);
  }

  /** Serialize imports and let inline saves wait for the same in-flight work. */
  async function mergeGuestEntries(account = session) {
    if (!account || session?.id !== account.id) return { merged: 0, kept: 0 };
    if (guestMergePromise) {
      const sameAccount = guestMergeAccountId === account.id;
      const result = await guestMergePromise;
      return sameAccount ? result : mergeGuestEntries(account);
    }
    const entries = readGuestEntries().filter((entry) => !entry.accountId || entry.accountId === account.id);
    if (!entries.length) {
      mergeFailure = null;
      return { merged: 0, kept: 0 };
    }
    guestMergeAccountId = account.id;
    guestMergePromise = importGuestEntries(account, entries);
    try {
      return await guestMergePromise;
    } finally {
      guestMergePromise = null;
      guestMergeAccountId = null;
    }
  }

  async function importGuestEntries(account, entries) {
    let merged = 0;
    let kept = 0;
    try {
      // Recover successful writes after a reload or failed local cleanup.
      const existing = await store.listSubmissions({ accountId: account.id });
      for (const [index, snapshot] of entries.entries()) {
        if (session?.id !== account.id) {
          kept += entries.length - index;
          break;
        }
        try {
          // Bind before sending. If storage refuses this write, nothing is
          // exported, and a later account cannot inherit an earlier import.
          const entry = claimGuestEntry(snapshot.id, account.id);
          if (!entry) throw new Error('The browser could not prepare this response.');
          let saved = matchingResponse(existing, account.id, entry.noteId, entry.reflection);
          if (!saved) {
            const result = await store.createSubmission({
              accountId: account.id,
              noteId: entry.noteId,
              noteTitle: entry.noteTitle,
              reflection: entry.reflection,
              evidence: [],
            });
            saved = result.submission;
            existing.push(saved);
          }
          const current = readGuestEntries().find((value) => value.id === entry.id);
          if (current?.reflection === entry.reflection && current.at === entry.at) {
            if (!removeGuestEntries([entry.id])) kept += 1;
          }
          if (session?.id === account.id) {
            for (const block of document.querySelectorAll('.inline-activity')) {
              const controller = inlineByBlock.get(block);
              if (controller?.noteId === entry.noteId) {
                controller.lastSaved = { accountId: account.id, reflection: entry.reflection, status: saved.status };
                refreshInlineActivity(controller);
              }
            }
          }
          merged += 1;
        } catch {
          kept += 1;
        }
      }
    } catch {
      kept = entries.length;
    }
    mergeFailure = kept ? { kept, accountId: account.id } : null;
    if (merged || kept) notifyChange();
    if (merged) announce(`${merged} saved ${merged === 1 ? 'activity' : 'activities'} added to your account.`);
    if (kept) announce('Some responses are still on this device. Try again from User to finish moving them to your account.');
    return { merged, kept };
  }

  /**
   * A restored signed-in session (a reload, a magic-link return) still needs
   * the browser's saved entries moved. Fired without awaiting so it cannot
   * delay or recurse into `init`; the guard keeps it to one attempt per boot.
   */
  function maybeMergeRestoredGuests() {
    if (restoredMergeChecked || !ready || !session) return;
    restoredMergeChecked = true;
    mergeGuestEntries(session).catch(() => {
      // A store-level failure must not break sign-in or note rendering.
      const kept = readGuestEntries().length;
      if (kept) mergeFailure = { kept, accountId: session?.id ?? null };
    });
  }

  /* ---------------------------------------------------------- log activity --- */

  async function openActivityDialog(note) {
    await init();
    if (!ready) {
      announce(failure?.message
        ?? 'Activity logging is unavailable because this browser gave the demo no storage.');
      return;
    }
    if (!session) {
      openSignInDialog({
        intro: remote
          ? 'Sign in to keep this activity in your portfolio. Or save it on this device for now.'
          : 'Sign in to keep this activity. Or save it on this device for now.',
        onSignedIn: () => {
          openActivityDialog(note);
        },
        onGuest: () => {
          openGuestActivityDialog(note);
        },
      });
      return;
    }

    const entry = createDialog({ title: `Log activity — ${note.title || note.id}`, className: 'demo-dialog-activity' });
    entry.body.append(el('p', 'demo-lede', remote
      ? 'Your submission is saved as pending review. A reviewer can read it and any evidence you attach.'
      : 'Your submission is saved in this browser as pending review.'));

    const form = el('form', 'demo-form');
    form.noValidate = true;
    const prefix = `demo-activity-${dialogCounter}`;

    const reflectionField = buildField({
      id: `${prefix}-reflection`,
      labelText: 'Reflection',
      rows: 5,
      hint: remote
        ? 'Optional if you attach a file. Saved with your account and visible to reviewers.'
        : 'Optional if you attach a file. Nothing here is sent anywhere.',
      maxLength: DEMO_LIMITS.maxReflectionLength,
    });

    const evidenceField = buildField({
      id: `${prefix}-evidence`,
      labelText: 'Evidence files',
      type: 'file',
      hint: `Up to ${DEMO_LIMITS.maxEvidenceFiles} files, ${formatBytes(DEMO_LIMITS.maxEvidenceFileBytes)} each `
        + `(${formatBytes(DEMO_LIMITS.maxEvidenceTotalBytes)} in total). `
        + 'PNG, JPEG, GIF, WebP and AVIF preview in the page; everything else is offered as a download. '
        + 'HTML and SVG files are never opened in the page.',
    });
    const fileInput = evidenceField.control;
    fileInput.multiple = true;
    fileInput.accept = EVIDENCE_ACCEPT;
    fileInput.className = 'demo-control demo-file';

    const summary = el('p', 'demo-error demo-error-summary');
    summary.hidden = true;
    summary.setAttribute('role', 'alert');

    const actions = el('div', 'demo-dialog-actions');
    const cancel = button('Cancel', 'demo-button');
    const save = el('button', 'demo-button demo-button-primary', 'Save as pending');
    save.type = 'submit';
    actions.append(cancel, save);

    form.append(reflectionField.wrap, evidenceField.wrap, summary, actions);
    entry.body.append(form);

    cancel.addEventListener('click', () => entry.close());

    let saving = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;

      const files = [...(fileInput.files ?? [])];
      const checked = validateSubmissionInput({
        reflection: reflectionField.control.value,
        files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
      });
      reflectionField.setError(checked.errors.reflection);
      evidenceField.setError(checked.errors.evidence);
      summary.textContent = checked.errors.summary ?? '';
      summary.hidden = !checked.errors.summary;
      if (!checked.ok) return;

      saving = true;
      save.disabled = true;
      try {
        const evidence = [];
        for (const file of files) {
          // Read the bytes before the store opens its transaction.
          evidence.push({
            name: file.name,
            type: file.type,
            size: file.size,
            bytes: await file.arrayBuffer(),
          });
        }
        await store.createSubmission({
          accountId: session.id,
          noteId: note.id,
          noteTitle: note.title || note.id,
          reflection: checked.reflection,
          evidence,
        });
        entry.close();
        announce(remote
          ? 'Activity logged and saved as pending review.'
          : 'Activity logged and saved as pending review in this browser.');
        // The dialog closes, but the short log link stays in the article beside
        // the control that opened it.
        showActivityLogLinkForNote(note.id);
        notifyChange();
      } catch (error) {
        // The form keeps everything the reader typed or chose.
        summary.textContent = error?.message ?? 'That submission could not be saved.';
        summary.hidden = false;
        saving = false;
        save.disabled = false;
      }
    });

    openDialog(entry, () => reflectionField.control.focus());
    return entry;
  }

  /* --------------------------------------------------------- clear data --- */

  function openClearDataDialog() {
    const entry = createDialog({ title: 'Clear local demo data', className: 'demo-dialog-confirm' });
    entry.body.append(el('p', 'demo-lede',
      'This removes every account, submission, uploaded file and reading statistic this browser '
      + 'holds for the demo, then restores the synthetic fixtures. It cannot be undone.'));

    const actions = el('div', 'demo-dialog-actions');
    const cancel = button('Cancel', 'demo-button');
    const confirm = button('Clear local data', 'demo-button demo-button-danger');
    actions.append(cancel, confirm);
    entry.body.append(actions);

    cancel.addEventListener('click', () => entry.close());
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        // Stop the tracker before the reset: no new statistics write may be
        // issued, and the ones already in flight must land first, or a late
        // write would recreate a row for an account the reset just deleted.
        await beforeReset?.();
        // Clearing and re-seeding are one transaction; a failed reset leaves
        // the existing demo data intact rather than half-cleared.
        await store.resetAll();
        afterReset?.({ ok: true });
        setSession(null);
        entry.close();
        announce('Local demo data cleared. Synthetic fixtures restored.');
      } catch (error) {
        afterReset?.({ ok: false });
        entry.body.append(el('p', 'demo-error', error?.message ?? 'Local data could not be cleared.'));
        confirm.disabled = false;
      }
    });

    openDialog(entry, () => confirm.focus());
    return entry;
  }

  /* ------------------------------------------------------- submission rows --- */

  function buildHistoryDetails(events) {
    const details = el('details', 'demo-history');
    details.append(el('summary', 'demo-history-summary', `Review history (${events.length})`));
    if (!events.length) {
      details.append(el('p', 'demo-caption', 'No review yet.'));
      return details;
    }
    const list = el('ul', 'demo-history-list');
    for (const event of events) {
      const item = el('li', 'demo-history-item');
      item.append(el('span', 'demo-history-status', statusLabel(event.status)));
      item.append(el('span', 'demo-history-meta',
        `${formatTimestamp(event.at)} · ${event.reviewerEmail || 'unknown reviewer'}`));
      if (event.feedback) item.append(el('p', 'demo-history-feedback', event.feedback));
      list.append(item);
    }
    details.append(list);
    return details;
  }

  function buildSubmissionRow(article, submission, evidence, events, { viewer, generation }) {
    const item = el('li', 'demo-row');
    const head = el('div', 'demo-row-head');
    head.append(el('h3', 'demo-row-title', submission.noteTitle || submission.noteId));
    const pill = el('span', `demo-status demo-status-${submission.status}`, statusLabel(submission.status));
    head.append(pill);
    if (viewer === 'admin') head.append(el('span', 'demo-row-author', submission.authorEmail || submission.accountId));
    item.append(head);

    const meta = [
      formatTimestamp(submission.createdAt),
      submission.pinned ? 'Pinned' : null,
      submission.evidence.length ? `${submission.evidence.length} file${submission.evidence.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    item.append(el('p', 'demo-row-meta', meta.join(' · ')));
    item.append(buildActivityTags(submission.noteId));

    if (submission.reflection) item.append(el('p', 'demo-reflection', submission.reflection));
    else item.append(el('p', 'demo-caption', 'No written reflection. Evidence only.'));

    item.append(buildEvidenceList(article, evidence, generation));

    if (submission.lastFeedback && submission.status === 'changes_requested') {
      item.append(el('p', 'demo-feedback', `Reviewer: ${submission.lastFeedback}`));
    }

    item.append(buildHistoryDetails(events));

    if (viewer === 'owner') {
      const actions = el('div', 'demo-row-actions');
      const pin = button(submission.pinned ? 'Unpin' : 'Pin', 'demo-button demo-button-small');
      pin.setAttribute('aria-pressed', submission.pinned ? 'true' : 'false');
      pin.setAttribute('aria-label',
        `${submission.pinned ? 'Unpin' : 'Pin'} the ${submission.noteTitle || submission.noteId} submission from ${formatTimestamp(submission.createdAt)}`);
      pin.addEventListener('click', async () => {
        pin.disabled = true;
        try {
          await store.setPin(session.id, submission.id, !submission.pinned);
          announce(submission.pinned ? 'Removed from your pinned portfolio.' : 'Pinned to your portfolio.');
          notifyChange();
        } catch (error) {
          pin.disabled = false;
          announce(error?.message ?? 'That pin could not be changed.');
        }
      });
      actions.append(pin);
      item.append(actions);
    } else {
      item.append(buildReviewForm(submission));
    }

    return item;
  }

  function buildReviewForm(submission) {
    const form = el('form', 'demo-form demo-review');
    form.noValidate = true;
    const prefix = `demo-review-${submission.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

    const statusWrap = el('div', 'demo-field');
    const statusLabelEl = el('label', 'demo-label', 'Review status');
    statusLabelEl.htmlFor = `${prefix}-status`;
    const select = document.createElement('select');
    select.id = `${prefix}-status`;
    select.className = 'demo-control demo-select';
    for (const value of SUBMISSION_STATUSES) {
      const option = el('option', '', statusLabel(value));
      option.value = value;
      if (value === submission.status) option.selected = true;
      select.append(option);
    }
    statusWrap.append(statusLabelEl, select);

    const feedbackField = buildField({
      id: `${prefix}-feedback`,
      labelText: 'Feedback',
      rows: 3,
      hint: 'Required when requesting changes.',
      maxLength: DEMO_LIMITS.maxFeedbackLength,
    });

    const actions = el('div', 'demo-dialog-actions');
    const save = el('button', 'demo-button demo-button-small demo-button-primary', 'Save review');
    save.type = 'submit';
    actions.append(save);

    form.append(statusWrap, feedbackField.wrap, actions);

    let saving = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      const status = select.value;
      const problem = validateFeedback(feedbackField.control.value, { required: status === 'changes_requested' });
      feedbackField.setError(problem);
      if (problem) return;

      saving = true;
      save.disabled = true;
      try {
        await store.reviewSubmission({
          submissionId: submission.id,
          status,
          feedback: feedbackField.control.value,
          reviewerEmail: session?.email ?? DEMO_ADMIN_EMAIL,
        });
        announce(`Review saved: ${statusLabel(status)}.`);
        notifyChange();
      } catch (error) {
        feedbackField.setError(error?.message ?? 'That review could not be saved.');
        saving = false;
        save.disabled = false;
      }
    });

    return form;
  }

  /* ------------------------------------------------------ view: account --- */

  async function loadAccountData() {
    // Snapshot the account once: a sign-out or an account switch mid-read must
    // not mix one reader's submissions with another's.
    const account = session;
    const accountId = account?.id ?? null;
    const [submissions, stats] = await Promise.all([
      accountId ? store.listSubmissions({ accountId }) : Promise.resolve([]),
      accountId ? store.getStats(accountId) : Promise.resolve(null),
    ]);
    const evidence = new Map();
    const events = new Map();
    // The independent evidence and history reads run together; one note's files
    // never wait on another note's history.
    await Promise.all(submissions.map(async (submission) => {
      const [files, history] = await Promise.all([
        store.listEvidence(submission.id),
        store.listReviewEvents(submission.id),
      ]);
      evidence.set(submission.id, files);
      events.set(submission.id, history);
    }));
    return { submissions, evidence, events, stats, accountId };
  }

  /** The one history list: guest rows and account rows share the same shape. */
  function buildActivityHistory(article, data, generation, { guest }) {
    const history = section('Activity history');
    history.id = 'activity-history';
    history.dataset.accountSection = 'activity-history';
    const heading = history.querySelector('.demo-section-title');
    if (heading) heading.tabIndex = -1;

    const records = guest ? unclaimedGuestEntries().slice().reverse() : data.submissions;
    if (!records.length) {
      history.append(el('p', 'demo-caption', 'No activity logged yet.'));
      return history;
    }
    const list = el('ul', 'demo-list');
    for (const record of records) {
      if (guest) {
        list.append(buildGuestRow(record));
      } else {
        list.append(buildSubmissionRow(
          article,
          record,
          data.evidence.get(record.id) ?? [],
          data.events.get(record.id) ?? [],
          { viewer: 'owner', generation },
        ));
      }
    }
    history.append(list);
    return history;
  }

  /** The guest's one quiet way in, kept below the collection and the history. */
  function buildGuestSignIn() {
    const signIn = section('Sign in');
    signIn.dataset.accountSection = 'sign-in';
    signIn.append(el('p', 'demo-lede', remote
      ? 'Keep your responses in your portfolio with a one-time email link. No password.'
      : 'Keep your responses in your portfolio. Any address works; no password, and no email is sent.'));
    const built = buildSignInForm({
      idPrefix: 'demo-pane-signin',
      onSignedIn: () => notifyChange(),
    });
    signIn.append(built.form);
    return signIn;
  }

  function buildAccountView(article, data, generation) {
    const fragment = document.createDocumentFragment();
    fragment.append(el('h1', 'demo-title', 'User'));

    const guest = !session;
    const records = guest ? unclaimedGuestEntries() : data.submissions;

    // The reader's own pile opens the page, and it is the same section for a
    // guest and for a signed-in reader: nothing here waits on a login.
    const collection = mountCollection(article, records, session?.id ?? 'guest');
    collection.element.dataset.accountSection = 'your-collection';
    fragment.append(collection.element);

    fragment.append(buildActivityHistory(article, data, generation, { guest }));

    if (guest) {
      if (data.accountUnavailable) {
        const unavailable = section('Account unavailable');
        const retry = button('Try again', 'demo-button');
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          failure = null;
          initPromise = null;
          await init();
          notifyChange();
        });
        unavailable.append(retry);
        fragment.append(unavailable);
      } else fragment.append(buildGuestSignIn());
      fragment.append(buildScholarshipSection());
      if (!remote) fragment.append(el('p', 'demo-note', disclosureText()));
      return fragment;
    }

    const pinned = data.submissions.filter((submission) => submission.pinned);
    const portfolio = section('Pinned portfolio');
    portfolio.dataset.accountSection = 'pinned-portfolio';
    if (!pinned.length) {
      portfolio.append(el('p', 'demo-caption', 'Nothing pinned yet.'));
    } else {
      const gallery = el('ul', 'demo-gallery');
      for (const submission of pinned) {
        const card = el('li', 'demo-gallery-card');
        card.append(el('h3', 'demo-gallery-title', submission.noteTitle || submission.noteId));
        card.append(el('span', `demo-status demo-status-${submission.status}`, statusLabel(submission.status)));
        card.append(el('p', 'demo-gallery-meta', formatTimestamp(submission.createdAt)));
        card.append(buildActivityTags(submission.noteId));
        if (submission.reflection) {
          const excerpt = submission.reflection.length > 120
            ? `${submission.reflection.slice(0, 119)}…`
            : submission.reflection;
          card.append(el('p', 'demo-gallery-excerpt', excerpt));
        }
        gallery.append(card);
      }
      portfolio.append(gallery);
    }
    fragment.append(portfolio);

    // Entries the last merge could not import are still in this browser. Say so
    // plainly and offer the retry, rather than showing an empty portfolio.
    if (mergeFailure?.kept && mergeFailure.accountId === session.id) {
      const pending = section('Saved on this device');
      pending.dataset.accountSection = 'pending-merge';
      pending.append(el('p', 'demo-caption',
        `${mergeFailure.kept} saved ${mergeFailure.kept === 1 ? 'activity is' : 'activities are'} `
        + 'still on this device. Try again to finish moving them to your account.'));
      const retryActions = el('div', 'demo-actions');
      const retry = button('Try again', 'demo-button');
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          await mergeGuestEntries(session);
        } finally {
          retry.disabled = false;
          notifyChange();
        }
      });
      retryActions.append(retry);
      pending.append(retryActions);
      fragment.append(pending);
    }

    const summary = summarizeStats(data.stats);
    const counts = countByStatus(data.submissions);
    const reading = section('Your reading');
    reading.dataset.accountSection = 'your-reading';
    reading.append(definitionList([
      ['Active time', formatDuration(summary.activeMs)],
      ['Pages explored', String(summary.pagesExplored)],
      ['Submissions', `${counts.pending} pending · ${counts.verified} verified · ${counts.changes_requested} changes requested`],
    ]));
    reading.append(el('p', 'demo-caption', session.synthetic
      ? 'Synthetic sample data, not a real reader.'
      : (remote
        ? 'Measured while reading and stored with your account.'
        : 'Local estimate, measured in this browser only.')));
    fragment.append(reading);

    const account = section('Account');
    account.dataset.accountSection = 'account';
    account.append(el('p', 'demo-caption', `Signed in as ${session.email}.`));
    if (session.synthetic) {
      account.append(el('p', 'demo-caption', 'Synthetic demo participant, seeded in this browser.'));
    } else if (!remote) {
      account.append(el('p', 'demo-caption', 'Local account in this browser.'));
    }
    const actions = el('div', 'demo-actions');
    const signOut = button('Sign out', 'demo-button');
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      try {
        await store.writeSession(null);
        setSession(null);
        announce(remote ? 'Signed out.' : 'Signed out of the local demo account.');
      } catch (error) {
        signOut.disabled = false;
        announce(error?.message ?? 'Sign-out failed.');
      }
    });
    actions.append(signOut);

    if (canReview(session)) {
      const admin = button('Admin page', 'demo-button');
      admin.addEventListener('click', () => openView('admin'));
      actions.append(admin);
    }

    const clear = remote ? null : button('Clear local demo data', 'demo-button');
    if (clear) {
      clear.addEventListener('click', () => openClearDataDialog());
      actions.append(clear);
    }
    account.append(actions);
    fragment.append(account);

    fragment.append(buildScholarshipSection());
    return fragment;
  }

  /* -------------------------------------------------------- view: settings --- */

  /**
   * Appearance is a browser-local preference with no account behind it, so this
   * view renders even when the demo store never opened. Choosing a preset
   * always applies it; if the browser refuses to remember it, the view says so
   * instead of pretending.
   */
  function buildSettingsView() {
    const fragment = document.createDocumentFragment();
    fragment.append(el('h1', 'demo-title', 'Settings'));
    fragment.append(el('p', 'demo-lede',
      'A few appearance choices for this browser. Nothing here is sent anywhere, and no account is needed.'));

    const layout = section('Reading');
    const layoutField = el('div', 'demo-field');
    const layoutLabel = el('label', 'demo-label', 'How notes open');
    layoutLabel.htmlFor = 'demo-reading-mode';
    const layoutSelect = document.createElement('select');
    layoutSelect.id = 'demo-reading-mode';
    layoutSelect.className = 'demo-control demo-select';
    for (const mode of READING_MODES) {
      const option = el('option', '', mode.label);
      option.value = mode.id;
      if (mode.id === currentReadingMode()) option.selected = true;
      layoutSelect.append(option);
    }
    const layoutHint = el('p', 'demo-hint');
    layoutHint.id = 'demo-reading-mode-hint';
    const describeLayout = (id) => READING_MODES.find((mode) => mode.id === id)?.description ?? '';
    layoutHint.textContent = describeLayout(currentReadingMode());
    layoutSelect.setAttribute('aria-describedby', 'demo-reading-mode-hint');
    // Breadcrumbs are a location aid, not navigation history. They default on
    // wherever the note declares a parent.
    const crumbs = document.createElement('input');
    crumbs.type = 'checkbox';
    crumbs.id = 'demo-breadcrumbs';
    crumbs.checked = document.documentElement.getAttribute('data-breadcrumbs') !== 'off';
    const crumbsLabel = el('label', 'demo-checkbox');
    crumbsLabel.htmlFor = 'demo-breadcrumbs';
    crumbsLabel.append(crumbs, document.createTextNode(' Show breadcrumbs'));
    crumbs.addEventListener('change', () => {
      const enabled = crumbs.checked;
      document.documentElement.setAttribute('data-breadcrumbs', enabled ? 'on' : 'off');
      try {
        localStorage.setItem('vitruvian.breadcrumbs', enabled ? 'on' : 'off');
      } catch {
        /* the choice still applies for this visit */
      }
      announce(enabled ? 'Breadcrumbs shown.' : 'Breadcrumbs hidden.');
    });
    layoutSelect.addEventListener('change', () => {
      const applied = changeReadingMode
        ? changeReadingMode(layoutSelect.value)
        : setReadingMode(layoutSelect.value).id;
      layoutHint.textContent = describeLayout(applied);
      announce(`Notes open as ${readingModeLabel(applied).toLowerCase()}.`);
    });
    layoutField.append(layoutLabel, layoutSelect, layoutHint);

    const random = document.createElement('input');
    random.type = 'checkbox';
    random.id = 'demo-random';
    random.checked = (() => {
      try {
        return localStorage.getItem('vitruvian.random') === 'on';
      } catch {
        return false;
      }
    })();
    const randomLabel = el('label', 'demo-checkbox');
    randomLabel.htmlFor = 'demo-random';
    randomLabel.append(random, document.createTextNode(' Show the random note button'));
    random.addEventListener('change', () => {
      changeRandom?.(random.checked);
      announce(random.checked ? 'Random note button shown.' : 'Random note button hidden.');
    });

    layout.append(layoutField, crumbsLabel, randomLabel);
    layout.append(el('p', 'demo-caption',
      'Page is the default: one note, ordinary links and browser Back. Stacked tabs keep earlier notes open to the left.'));
    fragment.append(layout);

    const appearance = section('Appearance');
    const field = el('div', 'demo-field');
    const label = el('label', 'demo-label', 'Stylesheet template');
    label.htmlFor = 'demo-appearance';

    const select = document.createElement('select');
    select.id = 'demo-appearance';
    select.className = 'demo-control demo-select';
    for (const preset of APPEARANCES) {
      const option = el('option', '', preset.label);
      option.value = preset.id;
      if (preset.id === currentAppearance()) option.selected = true;
      select.append(option);
    }

    const hint = el('p', 'demo-hint');
    const describe = (id) => {
      const preset = APPEARANCES.find((entry) => entry.id === id);
      return preset ? preset.description : '';
    };
    hint.textContent = describe(currentAppearance());
    select.setAttribute('aria-describedby', 'demo-appearance-hint');
    hint.id = 'demo-appearance-hint';

    select.addEventListener('change', () => {
      const { id, stored } = setAppearance(select.value);
      hint.textContent = describe(id);
      announce(stored
        ? `Appearance set to ${appearanceLabel(id)}.`
        : 'That appearance applies to this visit; this browser would not store the preference.');
    });

    field.append(label, select, hint);
    appearance.append(field);
    appearance.append(el('p', 'demo-caption',
      'Presets change colour only. No automatic switch follows your system setting.'));
    fragment.append(appearance);

    fragment.append(buildPortfolioSettings());

    if (!remote) fragment.append(el('p', 'demo-note', disclosureText()));
    return fragment;
  }

  /* --------------------------------------------------------- view: admin --- */

  async function loadAdminData() {
    const [accounts, submissions, stats] = await Promise.all([
      store.listAccounts(),
      store.listSubmissions(),
      store.listStats(),
    ]);
    const byEmail = new Map(accounts.map((account) => [account.id, account.email]));
    const evidence = new Map();
    const events = new Map();
    // Every submission's evidence and history reads run together, so a long
    // list is one round of parallel reads instead of a sequential walk.
    await Promise.all(submissions.map(async (submission) => {
      const [files, history] = await Promise.all([
        store.listEvidence(submission.id),
        store.listReviewEvents(submission.id),
      ]);
      evidence.set(submission.id, files);
      events.set(submission.id, history);
    }));
    const statsByAccount = new Map(stats.map((record) => [record.accountId, record]));
    return { accounts, submissions, byEmail, evidence, events, statsByAccount };
  }

  function buildAdminView(article, data, generation) {
    const fragment = document.createDocumentFragment();
    fragment.append(el('h1', 'demo-title', 'Admin'));
    fragment.append(el('p', 'demo-lede',
      remote
        ? 'Reviewer view. It can read every account, submission and uploaded file in this project.'
        : 'Local-only demo admin. It can read every account, submission and uploaded file stored in this browser.'));

    if (!session || !canReview(session)) {
      fragment.append(el('p', 'demo-caption', remote
        ? 'Sign in with a reviewer or admin account to review submissions.'
        : `Sign in as ${DEMO_ADMIN_EMAIL} from User to review submissions.`));
      if (!remote) fragment.append(el('p', 'demo-note', disclosureText()));
      return fragment;
    }

    const participants = section('Participants');
    const accountList = el('ul', 'demo-list');
    for (const account of data.accounts) {
      const stats = data.statsByAccount.get(account.id);
      const summary = summarizeStats(stats);
      const owned = data.submissions.filter((submission) => submission.accountId === account.id).length;
      const item = el('li', 'demo-row demo-row-compact');
      const head = el('div', 'demo-row-head');
      head.append(el('h3', 'demo-row-title', account.displayName || account.email));
      head.append(el('span', 'demo-status demo-status-plain',
        account.synthetic ? 'Synthetic' : 'Local account'));
      item.append(head);
      item.append(el('p', 'demo-row-meta', account.email));
      item.append(definitionList([
        ['Active time', formatDuration(summary.activeMs)],
        ['Pages explored', String(summary.pagesExplored)],
        ['Submissions', String(owned)],
      ]));
      item.append(el('p', 'demo-caption', account.synthetic
        ? 'Synthetic sample statistics, seeded with the demo.'
        : (remote
        ? 'Measured while reading and stored with your account.'
        : 'Local estimate, measured in this browser only.')));
      accountList.append(item);
    }
    participants.append(accountList);
    fragment.append(participants);

    const submissions = section('Submissions');
    if (!data.submissions.length) {
      submissions.append(el('p', 'demo-caption', 'No submissions in this browser yet.'));
    } else {
      const list = el('ul', 'demo-list');
      for (const submission of data.submissions) {
        list.append(buildSubmissionRow(
          article,
          { ...submission, authorEmail: data.byEmail.get(submission.accountId) ?? submission.accountId },
          data.evidence.get(submission.id) ?? [],
          data.events.get(submission.id) ?? [],
          { viewer: 'admin', generation },
        ));
      }
      submissions.append(list);
    }
    fragment.append(submissions);

    if (!remote) fragment.append(el('p', 'demo-note', disclosureText()));
    return fragment;
  }

  /* ----------------------------------------------------------- rendering --- */

  /* ------------------------------------------------------- the account view --- */

  /** The account-region content element, however the caller hands it over. */
  function contentHost(host) {
    if (!host) return null;
    if (host.classList?.contains('note-content')) return host;
    return host.querySelector?.('.note-content') ?? null;
  }

  function failureBlock(error) {
    const wrap = el('div', 'demo-failure');
    wrap.append(el('h1', 'demo-title', 'Account unavailable'));
    wrap.append(el('p', 'demo-lede',
      error?.message
      || 'This browser did not give the demo any local storage, so accounts and submissions cannot be shown.'));
    wrap.append(el('p', 'demo-caption', 'The notes themselves are unaffected.'));

    // A transient failure (an unreachable Supabase, say) is worth retrying, and
    // a stored session that cannot be refreshed must be clearable from here.
    const actions = el('div', 'demo-actions');
    const retry = button('Try again', 'demo-button');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      failure = null;
      initPromise = null;
      await init();
      notifyChange();
    });
    const signOut = button('Sign out', 'demo-button');
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      try {
        await store.writeSession(null);
      } catch {
        /* the local session is already the problem */
      }
      failure = null;
      initPromise = null;
      await init();
      notifyChange();
    });
    actions.append(retry, signOut);
    wrap.append(actions);
    if (!remote) wrap.append(el('p', 'demo-note', disclosureText()));
    return wrap;
  }

  /**
   * Renders one account region into its host element.
   *
   * The host is the full-page account content, not a reader pane, and it stays
   * connected while the reader is showing, so `isConnected` cannot be the guard:
   * `isCurrent` is the caller's region token, and the per-host render generation
   * plus the captured session identity are rechecked after every await. A render
   * that is no longer current must not build, commit or clean up after a newer
   * one.
   *
   * Returns whether this render committed, so the caller only moves focus for
   * the view that is actually on screen.
   */
  async function renderPane(host, view, { isCurrent = () => true } = {}) {
    const article = contentHost(host);
    if (!article) return false;
    const { generation, isCurrent: isCurrentGeneration } = renderGuard.begin(article, session?.id ?? null);
    const stillCurrent = () => isCurrentGeneration(session?.id ?? null) && isCurrent();

    revokePaneUrls(article);
    disposeCollection(article);

    // Appearance is a browser-local preference with no account behind it, so
    // Settings renders immediately and never waits on the store.
    if (view === 'settings') {
      article.replaceChildren(buildSettingsView());
      return true;
    }

    // Headings and quiet skeleton geometry instead of an empty region, painted
    // before the store is opened or any account data is read.
    article.replaceChildren(createAccountLoadingView(view, { session }));

    await init();
    if (!stillCurrent()) return false;

    if (!ready) {
      // Browser-only responses do not depend on the account database.
      if (view === 'account' && unclaimedGuestEntries().length) {
        article.replaceChildren(buildAccountView(article, {
          submissions: [], evidence: new Map(), events: new Map(), stats: null, accountUnavailable: true,
        }, generation));
      } else article.replaceChildren(failureBlock(failure));
      return true;
    }

    try {
      // Settle measured reading time first: the statistics below must include
      // the stretch the reader just finished, however short it was.
      await settleTracking();
      if (!stillCurrent()) return false;
      const data = view === 'admin' ? await loadAdminData() : await loadAccountData();
      if (!stillCurrent()) {
        revokePaneUrls(article, generation);
        return false;
      }
      const fragment = view === 'admin'
        ? buildAdminView(article, data, generation)
        : buildAccountView(article, data, generation);
      article.replaceChildren(fragment);
      return true;
    } catch (error) {
      // Only this render's object URLs go: a newer view may already be showing.
      revokePaneUrls(article, generation);
      if (!stillCurrent()) return false;
      article.replaceChildren(failureBlock(error));
      return true;
    }
  }

  /* ---------------------------------------------------- inline activities --- */

  /**
   * A `> [!activity]` callout is rendered by the Markdown layer as a section
   * with a prompt. The reader answers it in place: one reflection field, no
   * dialog, no sign-in gate. A guest answer lives in this browser until they
   * log in; an account answer is a review submission.
   */
  function inlineIdentity(block, note) {
    const title = block.dataset.activityTitle
      || block.querySelector('.inline-activity-title')?.textContent?.trim()
      || note?.title
      || note?.id
      || 'Activity';
    const activityId = block.dataset.activityId
      || block.querySelector('.inline-activity-title')?.id
      || 'activity';
    return {
      activityId,
      noteId: note?.id ? `${note.id}#${activityId}` : activityId,
      noteTitle: title,
    };
  }

  /**
   * Bring one control in step with the current session without discarding
   * unsaved typing. Text that was saved under another account (or under no
   * account) is cleared, so a sign-out never leaves one account's words sitting
   * in another's field.
   */
  function refreshInlineActivity(controller) {
    const account = session;
    const {
      field, status, save, login, privacy, logLink,
    } = controller;
    if (controller.sessionId && controller.sessionId !== (account?.id ?? null)) {
      field.control.value = '';
      field.setError(null);
      controller.lastSaved = null;
      controller.guestHydrated = false;
    }
    controller.sessionId = account?.id ?? null;

    if (account) {
      save.textContent = 'Save for review';
      login.hidden = true;
      privacy.textContent = 'Saved to your account and visible to reviewers. This is not a private journal.';
      const previous = controller.lastSaved;
      if (previous && previous.accountId !== account.id && field.control.value === previous.reflection) {
        field.control.value = '';
      }
      const mine = previous && previous.accountId === account.id;
      if (!controller.saving) {
        const label = previous?.status && previous.status !== 'pending' ? statusLabel(previous.status) : 'Pending review';
        status.textContent = mine
          ? (field.control.value.trim() === previous.reflection ? `${label} · Saved to your account.` : 'Unsaved changes.')
          : '';
      }
      // The log link follows this control's own save, and hides when the
      // account changed and the response is no longer in this browser.
      refreshActivityLogLink(logLink);
      logLink.hidden = !mine;
      return;
    }

    save.textContent = 'Save response';
    privacy.textContent = 'Saved only in this browser until you log in. Clearing browser data removes it.';
    const stored = guestEntryFor(controller.noteId);
    controller.guestSaved = stored?.reflection ?? null;
    login.hidden = !stored;
    if (!controller.guestHydrated && !field.control.value && controller.guestSaved) {
      field.control.value = controller.guestSaved;
    }
    controller.guestHydrated = true;
    if (!controller.saving) status.textContent = controller.guestSaved
      ? (field.control.value.trim() === controller.guestSaved ? 'Saved on this device.' : 'Unsaved changes.')
      : '';
    refreshActivityLogLink(logLink);
    logLink.hidden = !controller.guestSaved;
  }

  /** Refresh every embedded activity in the document after a session change. */
  function refreshInlineActivities() {
    if (typeof document === 'undefined') return;
    for (const block of document.querySelectorAll('.inline-activity')) {
      const controller = inlineByBlock.get(block);
      if (controller) refreshInlineActivity(controller);
    }
  }

  /** Hydrate one embedded activity, idempotently. */
  function hydrateInlineActivity(block, note) {
    const existing = inlineByBlock.get(block);
    if (existing) {
      refreshInlineActivity(existing);
      return;
    }
    const { noteId, noteTitle } = inlineIdentity(block, note);
    const idBase = `inline-activity-${++inlineCounter}`;
    const field = buildField({
      id: `${idBase}-response`,
      labelText: 'Your response',
      rows: 4,
      maxLength: DEMO_LIMITS.maxReflectionLength,
    });

    const form = el('form', 'inline-activity-form');
    form.noValidate = true;
    const privacy = el('p', 'demo-caption inline-activity-privacy');
    privacy.id = `${idBase}-privacy`;
    field.control.setAttribute('aria-describedby', `${field.error.id} ${privacy.id}`);
    const status = el('p', 'demo-caption inline-activity-status');
    status.setAttribute('role', 'status');
    const actions = el('div', 'inline-activity-actions');
    const save = el('button', 'demo-button demo-button-primary inline-activity-save', 'Save response');
    save.type = 'submit';
    const login = button('Log in', 'demo-button inline-activity-login');
    const logLink = buildActivityLogLink();
    actions.append(save, status, logLink, login);
    form.append(field.wrap, privacy, actions);

    const prompt = block.querySelector('.inline-activity-prompt');
    if (prompt?.parentNode) prompt.after(form);
    else block.append(form);

    const controller = {
      block, noteId, noteTitle, field, privacy, status, save, login, logLink,
      saving: false, guestSaved: null, guestHydrated: false, lastSaved: null, sessionId: null,
    };
    inlineByBlock.set(block, controller);
    field.control.addEventListener('input', () => {
      field.setError(null);
      if (controller.saving) return;
      const saved = session ? controller.lastSaved?.reflection : controller.guestSaved;
      if (field.control.value.trim() !== saved && status.textContent !== 'Unsaved changes.') {
        status.textContent = 'Unsaved changes.';
      }
    });

    login.addEventListener('click', () => {
      openSignInDialog({
        intro: 'Log in to keep the responses saved in this browser in your portfolio.',
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (controller.saving) return;

      const checked = validateSubmissionInput({ reflection: field.control.value, files: [] });
      const problem = checked.errors.reflection ?? (checked.ok ? null : 'Add a short reflection.');
      field.setError(problem);
      if (!checked.ok) return;

      // The session is captured before any await: a sign-out or navigation in
      // the middle of the save must not send this response somewhere else.
      const sessionAtStart = session?.id ?? null;
      controller.saving = true;
      save.disabled = true;
      status.textContent = 'Saving…';
      await init();
      if (guestMergePromise) await guestMergePromise;
      if (!block.isConnected || (session?.id ?? null) !== sessionAtStart) {
        controller.saving = false;
        save.disabled = false;
        refreshInlineActivity(controller);
        if (block.isConnected) field.setError('Your sign-in changed. Check who can read this response before saving again.');
        return;
      }
      const account = session;

      if (!account) {
        const stored = upsertGuestEntry({ noteId, noteTitle, reflection: checked.reflection });
        controller.saving = false;
        save.disabled = false;
        if (!stored) {
          field.setError('This browser would not store the response.');
          status.textContent = '';
          return;
        }
        field.setError(null);
        refreshInlineActivity(controller);
        notifyChange();
        announce('Saved on this device. Log in to keep it in your portfolio.');
        return;
      }

      try {
        // A manual account save must honor the same durable ownership boundary
        // as automatic imports, including when an earlier claim was refused.
        const anonymous = guestEntryFor(noteId);
        if (anonymous && !claimGuestEntry(anonymous.id, account.id)) {
          throw new Error('This browser could not prepare the saved response. It has not been sent to your account.');
        }
        const rows = await store.listSubmissions({ accountId: account.id });
        if (session?.id !== account.id) return;
        let saved = matchingResponse(rows, account.id, noteId, checked.reflection);
        if (!saved) {
          const result = await store.createSubmission({
            accountId: account.id,
            noteId,
            noteTitle,
            reflection: checked.reflection,
            evidence: [],
          });
          saved = result.submission;
        }
        if (anonymous?.reflection === checked.reflection) removeGuestEntries([anonymous.id]);
        const remaining = readGuestEntries().filter((entry) => !entry.accountId || entry.accountId === account.id);
        mergeFailure = remaining.length ? { kept: remaining.length, accountId: account.id } : null;
        if (session?.id === account.id) {
          controller.lastSaved = { accountId: account.id, reflection: checked.reflection, status: saved.status };
          field.setError(null);
          notifyChange();
        }
      } catch (error) {
        if (session?.id === account.id) {
          field.setError(error?.message ?? 'That response could not be saved.');
        }
      } finally {
        controller.saving = false;
        save.disabled = false;
        refreshInlineActivity(controller);
      }
    });

    refreshInlineActivity(controller);
  }

  /**
   * The one hook into note rendering. Embedded activities are always hydrated;
   * the standalone `activity: true` control is kept only for notes that carry no
   * embedded activity, so the two flows never double up. Hover previews never
   * call this, and the Markdown source never contains either control.
   */
  function decorateArticle(article, note) {
    if (!article) return;
    const blocks = article.querySelectorAll('.inline-activity');
    for (const block of blocks) hydrateInlineActivity(block, note);

    if (note?.activity !== true || blocks.length) return;
    if (article.querySelector('.demo-log-activity')) return;
    const wrap = el('div', 'demo-activity-actions');
    const log = button('Log activity', 'demo-button demo-button-primary demo-log-activity');
    log.dataset.noteId = note.id;
    log.addEventListener('click', () => {
      openActivityDialog(note);
    });
    wrap.append(el('span', 'demo-activity-kicker', 'Try this activity'));
    wrap.append(log);
    article.append(wrap);
    syncGuestMarker(note.id);
  }

  function releasePane(host) {
    const article = contentHost(host) ?? host;
    // A pile in a region that is leaving must stop animating before its DOM
    // goes, or its frame or observer would keep the detached view alive.
    disposeCollection(article);
    revokePaneUrls(article);
  }

  return {
    init,
    renderPane,
    decorateArticle,
    releasePane,
    closeDialogs,
    hasOpenDialog,
    openActivityDialog,
    openSignInDialog,
    openClearDataDialog,
    get session() {
      return session;
    },
    canReview(account = session) {
      return canReview(account);
    },
    get ready() {
      return ready;
    },
    get failure() {
      return failure;
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onDialogChange(listener) {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
  };
}
