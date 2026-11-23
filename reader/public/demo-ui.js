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

export function createDemoUi({
  store,
  announce = () => {},
  openView = () => {},
  changeReadingMode = null,
  settleTracking = async () => {},
  beforeReset = null,
  afterReset = null,
} = {}) {
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
    return initPromise;
  }

  function notifyChange() {
    for (const listener of changeListeners) listener();
  }

  function setSession(account) {
    session = account ?? null;
    notifyChange();
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
      hint: 'Any address works. Nothing is sent, and there is no password.',
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
      hint: 'Type the code shown above.',
    });
    const codeDisplay = el('p', 'demo-code');
    codeDisplay.append('Demo verification code, shown on screen because this demo sends no email: ');
    codeDisplay.append(el('code', 'demo-code-value', DEMO_VERIFICATION_CODE));
    const codeStep = el('div', 'demo-signin-step');
    codeStep.hidden = true;
    const codeActions = el('div', 'demo-dialog-actions');
    const backButton = button('Use a different email', 'demo-button');
    const signInButton = el('button', 'demo-button demo-button-primary', 'Sign in');
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
        step = 'code';
        emailStep.hidden = true;
        codeStep.hidden = false;
        codeField.control.focus();
        announce('Demo verification code shown on screen. Enter it to finish signing in.');
        return;
      }

      const problem = validateVerificationCode(codeField.control.value);
      codeField.setError(problem);
      if (problem) return;

      saving = true;
      signInButton.disabled = true;
      try {
        const { account, created } = await store.signIn(emailField.control.value);
        await store.writeSession(account.id);
        setSession(account);
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

  function openSignInDialog({ onSignedIn, intro } = {}) {
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
    entry.body.append(el('p', 'demo-note', DEMO_DISCLOSURE));
    openDialog(entry, built.focus);
    return entry;
  }

  /* ---------------------------------------------------------- log activity --- */

  async function openActivityDialog(note) {
    await init();
    if (!ready) {
      announce('Activity logging is unavailable because this browser gave the demo no storage.');
      return;
    }
    if (!session) {
      openSignInDialog({
        intro: 'Sign in first. The activity is logged straight after, and stays in this browser.',
        onSignedIn: () => {
          openActivityDialog(note);
        },
      });
      return;
    }

    const entry = createDialog({ title: `Log activity — ${note.title || note.id}`, className: 'demo-dialog-activity' });
    entry.body.append(el('p', 'demo-lede', 'Your submission is saved in this browser as pending review.'));

    const form = el('form', 'demo-form');
    form.noValidate = true;
    const prefix = `demo-activity-${dialogCounter}`;

    const reflectionField = buildField({
      id: `${prefix}-reflection`,
      labelText: 'Reflection',
      rows: 5,
      hint: 'Optional if you attach a file. Nothing here is sent anywhere.',
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
        announce('Activity logged and saved as pending review in this browser.');
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
    const submissions = session ? await store.listSubmissions({ accountId: session.id }) : [];
    const evidence = new Map();
    const events = new Map();
    for (const submission of submissions) {
      evidence.set(submission.id, await store.listEvidence(submission.id));
      events.set(submission.id, await store.listReviewEvents(submission.id));
    }
    const stats = session ? await store.getStats(session.id) : null;
    return { submissions, evidence, events, stats };
  }

  function buildAccountView(article, data, generation) {
    const fragment = document.createDocumentFragment();
    fragment.append(el('h1', 'demo-title', 'User info'));

    if (!session) {
      fragment.append(el('p', 'demo-lede',
        'Sign in with an email address to log activities and keep a portfolio. '
        + 'This is a local demo: there is no password, and no email is sent.'));
      const built = buildSignInForm({
        idPrefix: 'demo-pane-signin',
        onSignedIn: () => notifyChange(),
      });
      fragment.append(built.form);
      fragment.append(el('p', 'demo-note', DEMO_DISCLOSURE));
      return fragment;
    }

    fragment.append(el('p', 'demo-lede', `Signed in as ${session.email}.`));
    fragment.append(el('p', 'demo-caption', session.synthetic
      ? 'Synthetic demo participant, seeded in this browser.'
      : 'Local account in this browser.'));

    // The portfolio and history are the point of this view; the reading
    // statistics are a secondary footnote below them.
    const pinned = data.submissions.filter((submission) => submission.pinned);
    const portfolio = section('Pinned portfolio');
    if (!pinned.length) {
      portfolio.append(el('p', 'demo-caption', 'Nothing pinned yet.'));
    } else {
      const gallery = el('ul', 'demo-gallery');
      for (const submission of pinned) {
        const card = el('li', 'demo-gallery-card');
        card.append(el('h3', 'demo-gallery-title', submission.noteTitle || submission.noteId));
        card.append(el('span', `demo-status demo-status-${submission.status}`, statusLabel(submission.status)));
        card.append(el('p', 'demo-gallery-meta', formatTimestamp(submission.createdAt)));
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

    const history = section('Activity history');
    if (!data.submissions.length) {
      history.append(el('p', 'demo-caption', 'No activity logged yet.'));
    } else {
      const list = el('ul', 'demo-list');
      for (const submission of data.submissions) {
        list.append(buildSubmissionRow(
          article,
          submission,
          data.evidence.get(submission.id) ?? [],
          data.events.get(submission.id) ?? [],
          { viewer: 'owner', generation },
        ));
      }
      history.append(list);
    }
    fragment.append(history);

    const summary = summarizeStats(data.stats);
    const counts = countByStatus(data.submissions);
    const reading = section('Your reading');
    reading.append(definitionList([
      ['Active time', formatDuration(summary.activeMs)],
      ['Pages explored', String(summary.pagesExplored)],
      ['Submissions', `${counts.pending} pending · ${counts.verified} verified · ${counts.changes_requested} changes requested`],
    ]));
    reading.append(el('p', 'demo-caption', session.synthetic
      ? 'Synthetic sample data, not a real reader.'
      : 'Local estimate, measured in this browser only.'));
    fragment.append(reading);

    const account = section('Account');
    const actions = el('div', 'demo-actions');
    const signOut = button('Sign out', 'demo-button');
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      try {
        await store.writeSession(null);
        setSession(null);
        announce('Signed out of the local demo account.');
      } catch (error) {
        signOut.disabled = false;
        announce(error?.message ?? 'Sign-out failed.');
      }
    });
    actions.append(signOut);

    if (isAdminEmail(session.email)) {
      const admin = button('Admin page', 'demo-button');
      admin.addEventListener('click', () => openView('admin'));
      actions.append(admin);
    }

    const clear = button('Clear local demo data', 'demo-button');
    clear.addEventListener('click', () => openClearDataDialog());
    actions.append(clear);
    account.append(actions);
    fragment.append(account);

    fragment.append(el('p', 'demo-note', DEMO_DISCLOSURE));
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
    layoutSelect.addEventListener('change', () => {
      const applied = changeReadingMode
        ? changeReadingMode(layoutSelect.value)
        : setReadingMode(layoutSelect.value).id;
      layoutHint.textContent = describeLayout(applied);
      announce(`Notes open as ${readingModeLabel(applied).toLowerCase()}.`);
    });
    layoutField.append(layoutLabel, layoutSelect, layoutHint);
    layout.append(layoutField);
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
      'Presets change colour only. The reader stays light either way: there is no dark mode and no automatic switch.'));
    fragment.append(appearance);

    fragment.append(el('p', 'demo-note', DEMO_DISCLOSURE));
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
    for (const submission of submissions) {
      evidence.set(submission.id, await store.listEvidence(submission.id));
      events.set(submission.id, await store.listReviewEvents(submission.id));
    }
    const statsByAccount = new Map(stats.map((record) => [record.accountId, record]));
    return { accounts, submissions, byEmail, evidence, events, statsByAccount };
  }

  function buildAdminView(article, data, generation) {
    const fragment = document.createDocumentFragment();
    fragment.append(el('h1', 'demo-title', 'Admin'));
    fragment.append(el('p', 'demo-lede',
      'Local-only demo admin. It can read every account, submission and uploaded file stored in this browser.'));

    if (!session || !isAdminEmail(session.email)) {
      fragment.append(el('p', 'demo-caption',
        `Sign in as ${DEMO_ADMIN_EMAIL} from User info to review submissions.`));
      fragment.append(el('p', 'demo-note', DEMO_DISCLOSURE));
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
        : 'Local estimate, measured in this browser only.'));
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

    fragment.append(el('p', 'demo-note', DEMO_DISCLOSURE));
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
    wrap.append(el('h1', 'demo-title', 'User info is unavailable'));
    wrap.append(el('p', 'demo-lede',
      error?.message
      || 'This browser did not give the demo any local storage, so accounts and submissions cannot be shown.'));
    wrap.append(el('p', 'demo-caption', 'The notes themselves are unaffected.'));
    wrap.append(el('p', 'demo-note', DEMO_DISCLOSURE));
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
    article.replaceChildren();

    await init();
    if (!stillCurrent()) return false;

    // Appearance is a browser-local preference with no account behind it, so
    // Settings renders even when the demo store never opened.
    if (view === 'settings') {
      article.replaceChildren(buildSettingsView());
      return true;
    }

    if (!ready) {
      article.append(failureBlock(failure));
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

  /**
   * The one hook into note rendering: a single small control, only for a note
   * whose frontmatter says `activity: true`. Hover previews never call this, and
   * the Markdown source never contains it.
   */
  function decorateArticle(article, note) {
    if (!article || note?.activity !== true) return;
    if (article.querySelector('.demo-log-activity')) return;
    const wrap = el('div', 'demo-activity-actions');
    const log = button('Log activity', 'demo-button demo-log-activity');
    log.addEventListener('click', () => {
      openActivityDialog(note);
    });
    wrap.append(log);
    wrap.append(el('p', 'demo-caption', 'Saved in this browser only, as a pending submission.'));
    article.append(wrap);
  }

  function releasePane(host) {
    revokePaneUrls(contentHost(host) ?? host);
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
