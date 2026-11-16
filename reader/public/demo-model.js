/**
 * demo-model.js — the rules of the browser-only participation demo.
 *
 * Pure data, validation and formatting. No DOM, no IndexedDB, no network, so
 * the rules can be read and tested on their own. `demo-store.js` persists these
 * records; `demo-ui.js` renders them.
 *
 * None of this is authentication. The "verification code" is a constant printed
 * on screen because there is no email delivery, no password and no server.
 */

/**
 * The two reserved pane ids from the previous design, when the account and admin
 * views were panes inside the reading stack.
 *
 * They are *legacy URL values only*. `view-route.js` still reads them out of old
 * `?note=` / `?stackedNotes=` parameters and migrates them to the matching
 * full-page account region, and `demo-tracking.js` still excludes them from
 * measurable notes. They are never written back to a URL, and `app.js` rejects
 * them as new reader panes, so nothing can open them again.
 */
export const DEMO_PANE_ACCOUNT = 'demo:account';
export const DEMO_PANE_ADMIN = 'demo:admin';
export const DEMO_PANE_IDS = Object.freeze([DEMO_PANE_ACCOUNT, DEMO_PANE_ADMIN]);

/**
 * Shown on screen, and only on screen. A real deployment would deliver this to
 * the address instead; here it is a label, not a secret.
 */
export const DEMO_VERIFICATION_CODE = '482913';

export const DEMO_ADMIN_EMAIL = 'admin@vitruvian.demo';

/** One paragraph, reused by the UI and the README so the wording cannot drift. */
export const DEMO_DISCLOSURE =
  'Insecure local-only demo. There is no server, no real authentication and no email. ' +
  'Accounts, submissions and uploaded evidence are kept in this browser for this origin only, ' +
  'and may be lost or cleared at any time. The demo admin page can inspect every account ' +
  'stored in this browser.';

export const DEMO_LIMITS = Object.freeze({
  maxEmailLength: 254,
  maxDisplayNameLength: 60,
  maxReflectionLength: 4000,
  maxFeedbackLength: 1000,
  maxEvidenceFiles: 3,
  maxEvidenceFileBytes: 2 * 1024 * 1024,
  maxEvidenceTotalBytes: 4 * 1024 * 1024,
  maxEvidenceNameLength: 120,
});

export const SUBMISSION_STATUSES = Object.freeze(['pending', 'verified', 'changes_requested']);

export const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  verified: 'Verified',
  changes_requested: 'Changes requested',
});

/** Formats a file can be previewed in the page. SVG is deliberately absent. */
export const PREVIEW_IMAGE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export function isDemoPaneId(id) {
  return DEMO_PANE_IDS.includes(id);
}

export function demoPaneLabel(id) {
  if (id === DEMO_PANE_ACCOUNT) return 'User info';
  if (id === DEMO_PANE_ADMIN) return 'Admin';
  return null;
}

export function isSubmissionStatus(value) {
  return SUBMISSION_STATUSES.includes(value);
}

export function statusLabel(value) {
  return STATUS_LABELS[value] ?? 'Unknown';
}

export function canPreviewEvidence(type) {
  return PREVIEW_IMAGE_TYPES.includes(String(type || '').toLowerCase());
}

/* ------------------------------------------------------------------ ids --- */

/** Ids are opaque. The fallback matters on plain-HTTP hosts without `randomUUID`. */
export function createId(prefix, randomUUID = globalThis.crypto?.randomUUID) {
  const suffix = typeof randomUUID === 'function'
    ? randomUUID.call(globalThis.crypto)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${suffix}`;
}

/* ------------------------------------------------------------ accounts --- */

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isAdminEmail(value) {
  return normalizeEmail(value) === DEMO_ADMIN_EMAIL;
}

/** `ada@example.com` reads as `ada`; the address itself stays the identity. */
export function displayNameForEmail(email) {
  const local = normalizeEmail(email).split('@')[0] || 'Reader';
  return local.slice(0, DEMO_LIMITS.maxDisplayNameLength);
}

/** Returns a message, or null when the address is usable. */
export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return 'Enter an email address for this browser-local account.';
  if (email.length > DEMO_LIMITS.maxEmailLength) return 'That email address is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.';
  return null;
}

export function validateVerificationCode(value) {
  const code = String(value ?? '').trim();
  if (!code) return 'Enter the demo verification code shown above.';
  if (code !== DEMO_VERIFICATION_CODE) return 'That code does not match the code shown above.';
  return null;
}

/* --------------------------------------------------------- submissions --- */

function fileSize(file) {
  const size = Number(file?.size);
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
}

/** Returns a message, or null. `files` are `{ name, type, size }` descriptors. */
export function validateEvidenceFiles(files = []) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > DEMO_LIMITS.maxEvidenceFiles) {
    return `Attach at most ${DEMO_LIMITS.maxEvidenceFiles} files.`;
  }
  let total = 0;
  for (const file of list) {
    const name = String(file?.name ?? 'file');
    if (name.length > DEMO_LIMITS.maxEvidenceNameLength) return 'That file name is too long.';
    const size = fileSize(file);
    if (size === 0) return `“${name}” is empty, so there is nothing to store.`;
    if (size > DEMO_LIMITS.maxEvidenceFileBytes) {
      return `“${name}” is larger than ${formatBytes(DEMO_LIMITS.maxEvidenceFileBytes)}.`;
    }
    total += size;
  }
  if (total > DEMO_LIMITS.maxEvidenceTotalBytes) {
    return `Attached files total more than ${formatBytes(DEMO_LIMITS.maxEvidenceTotalBytes)}.`;
  }
  return null;
}

/**
 * A submission needs a trimmed reflection, a file, or both. The `summary` error
 * belongs next to the save control; the field errors belong next to the fields.
 */
export function validateSubmissionInput({ reflection = '', files = [] } = {}) {
  const text = String(reflection ?? '').trim();
  const errors = { reflection: null, evidence: null, summary: null };
  if (text.length > DEMO_LIMITS.maxReflectionLength) {
    errors.reflection = `Keep the reflection under ${DEMO_LIMITS.maxReflectionLength} characters.`;
  }
  errors.evidence = validateEvidenceFiles(files);
  if (!text && !files.length) {
    errors.summary = 'Add a reflection or attach a file before saving.';
  }
  if (errors.reflection || errors.evidence) {
    errors.summary = errors.summary ?? 'Check the highlighted field.';
  }
  const ok = !errors.reflection && !errors.evidence && !errors.summary;
  return { ok, reflection: text, errors };
}

export function validateFeedback(value, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) return 'Add feedback when requesting changes.';
  if (text.length > DEMO_LIMITS.maxFeedbackLength) {
    return `Keep feedback under ${DEMO_LIMITS.maxFeedbackLength} characters.`;
  }
  return null;
}

/** The record as stored. Evidence metadata only; bytes live in their own store. */
export function createSubmissionRecord({
  id, accountId, noteId, noteTitle, reflection, evidence = [], at,
}) {
  return {
    id,
    accountId,
    noteId,
    noteTitle,
    reflection,
    evidence: evidence.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      size: item.size,
    })),
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    reviewedAt: null,
    reviewedBy: null,
    lastFeedback: null,
  };
}

/**
 * A review is a status plus an optional note. The returned event is the
 * immutable history entry; the returned submission is the new current state.
 */
export function applyReview(submission, { status, feedback = '', reviewerEmail, at, eventId }) {
  if (!isSubmissionStatus(status)) throw new TypeError(`Unknown submission status: ${status}`);
  const note = String(feedback ?? '').trim();
  const next = {
    ...submission,
    status,
    updatedAt: at,
    reviewedAt: at,
    reviewedBy: reviewerEmail ?? null,
    lastFeedback: note || null,
  };
  const event = {
    id: eventId,
    submissionId: submission.id,
    accountId: submission.accountId,
    status,
    feedback: note || null,
    reviewerEmail: reviewerEmail ?? null,
    at,
  };
  return { submission: next, event };
}

/**
 * Merge pin state and order for display: pinned first (most recently pinned
 * first), then newest first. Pinned items also stay in the ordinary history.
 */
export function orderSubmissions(submissions, pins = new Map()) {
  const merged = submissions.map((submission) => {
    const pin = pins.get(submission.id) ?? null;
    return { ...submission, pinned: Boolean(pin), pinnedAt: pin?.at ?? null };
  });
  return merged.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return String(b.pinnedAt).localeCompare(String(a.pinnedAt));
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export function countByStatus(submissions = []) {
  const counts = { pending: 0, verified: 0, changes_requested: 0, total: submissions.length };
  for (const submission of submissions) {
    if (isSubmissionStatus(submission.status)) counts[submission.status] += 1;
  }
  return counts;
}

/* -------------------------------------------------------------- reading --- */

export function emptyStats(accountId) {
  return { accountId, pages: {}, activeMs: 0, updatedAt: null, synthetic: false };
}

/** A distinct page is a key in `pages`; repeat visits only move `count`. */
export function recordView(stats, noteId, at) {
  const base = stats ?? emptyStats(null);
  const previous = base.pages?.[noteId];
  return {
    ...base,
    pages: {
      ...(base.pages ?? {}),
      [noteId]: {
        count: (previous?.count ?? 0) + 1,
        firstAt: previous?.firstAt ?? at,
        lastAt: at,
      },
    },
    updatedAt: at,
  };
}

export function addActiveTime(stats, ms, at) {
  const base = stats ?? emptyStats(null);
  const added = Number(ms);
  if (!Number.isFinite(added) || added <= 0) return base;
  return { ...base, activeMs: (base.activeMs ?? 0) + Math.round(added), updatedAt: at };
}

export function summarizeStats(stats) {
  const pages = stats?.pages ?? {};
  const ids = Object.keys(pages);
  let views = 0;
  for (const id of ids) views += pages[id]?.count ?? 0;
  return { pagesExplored: ids.length, activeMs: stats?.activeMs ?? 0, views };
}

/* ------------------------------------------------------------ formatting --- */

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    const kb = value / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/* ----------------------------------------------------------------- seeds --- */

const encoder = new TextEncoder();

/**
 * A small, fixed set of synthetic participants and submissions, so the demo has
 * something to review on a fresh browser. Ids and timestamps are constants, so
 * seeding twice writes the same rows and the caller can detect a no-op.
 *
 * This is test fixture copy only. It is not activity instruction text, and the
 * activity notes in `vault/` are untouched.
 */
export function seedFixtures() {
  const breathNote = encoder.encode('Synthetic fixture for the demo admin page. Two slow breaths before the first meeting.\n');
  const moneyNote = encoder.encode('Synthetic fixture for the demo admin page. Reviewed the week of 5 January.\n');

  const accounts = [
    {
      id: 'seed:account:ada',
      email: 'ada@demo.invalid',
      displayName: 'Ada — synthetic participant',
      synthetic: true,
      createdAt: '2026-01-05T09:00:00.000Z',
    },
    {
      id: 'seed:account:ben',
      email: 'ben@demo.invalid',
      displayName: 'Ben — synthetic participant',
      synthetic: true,
      createdAt: '2026-01-06T09:00:00.000Z',
    },
    {
      id: 'seed:account:cy',
      email: 'cy@demo.invalid',
      displayName: 'Cy — synthetic participant',
      synthetic: true,
      createdAt: '2026-01-07T09:00:00.000Z',
    },
  ];

  const submissions = [
    {
      id: 'seed:submission:ada-breath',
      accountId: 'seed:account:ada',
      noteId: 'Breath',
      noteTitle: 'Breath',
      reflection: 'Tried the two-breath pause before the morning stand-up. Easier than expected.',
      evidence: [{ id: 'seed:evidence:ada-breath', name: 'breath-notes.txt', type: 'text/plain', size: breathNote.byteLength }],
      status: 'verified',
      createdAt: '2026-01-08T08:15:00.000Z',
      updatedAt: '2026-01-09T10:00:00.000Z',
      reviewedAt: '2026-01-09T10:00:00.000Z',
      reviewedBy: DEMO_ADMIN_EMAIL,
      lastFeedback: 'Clear and specific. Verified.',
    },
    {
      id: 'seed:submission:ada-movement',
      accountId: 'seed:account:ada',
      noteId: 'Movement',
      noteTitle: 'Movement',
      reflection: 'Walked instead of driving for the short errands this week.',
      evidence: [],
      status: 'pending',
      createdAt: '2026-01-12T18:40:00.000Z',
      updatedAt: '2026-01-12T18:40:00.000Z',
      reviewedAt: null,
      reviewedBy: null,
      lastFeedback: null,
    },
    {
      id: 'seed:submission:ben-reflection',
      accountId: 'seed:account:ben',
      noteId: 'Reflection',
      noteTitle: 'Reflection',
      reflection: 'Wrote three lines at the end of the day.',
      evidence: [],
      status: 'changes_requested',
      createdAt: '2026-01-11T20:05:00.000Z',
      updatedAt: '2026-01-13T09:30:00.000Z',
      reviewedAt: '2026-01-13T09:30:00.000Z',
      reviewedBy: DEMO_ADMIN_EMAIL,
      lastFeedback: 'Add a little more detail about what changed after writing.',
    },
    {
      id: 'seed:submission:cy-money',
      accountId: 'seed:account:cy',
      noteId: 'Money check-in',
      noteTitle: 'Money check-in',
      reflection: 'Checked the recurring payments and cancelled one that had crept up.',
      evidence: [{ id: 'seed:evidence:cy-money', name: 'money-week.txt', type: 'text/plain', size: moneyNote.byteLength }],
      status: 'verified',
      createdAt: '2026-01-10T07:45:00.000Z',
      updatedAt: '2026-01-10T16:20:00.000Z',
      reviewedAt: '2026-01-10T16:20:00.000Z',
      reviewedBy: DEMO_ADMIN_EMAIL,
      lastFeedback: 'Verified.',
    },
  ];

  const evidence = [
    {
      id: 'seed:evidence:ada-breath',
      submissionId: 'seed:submission:ada-breath',
      name: 'breath-notes.txt',
      type: 'text/plain',
      size: breathNote.byteLength,
      bytes: breathNote,
    },
    {
      id: 'seed:evidence:cy-money',
      submissionId: 'seed:submission:cy-money',
      name: 'money-week.txt',
      type: 'text/plain',
      size: moneyNote.byteLength,
      bytes: moneyNote,
    },
  ];

  const reviewEvents = [
    {
      id: 'seed:event:ada-breath-verified',
      submissionId: 'seed:submission:ada-breath',
      accountId: 'seed:account:ada',
      status: 'verified',
      feedback: 'Clear and specific. Verified.',
      reviewerEmail: DEMO_ADMIN_EMAIL,
      at: '2026-01-09T10:00:00.000Z',
    },
    {
      id: 'seed:event:ben-reflection-changes',
      submissionId: 'seed:submission:ben-reflection',
      accountId: 'seed:account:ben',
      status: 'changes_requested',
      feedback: 'Add a little more detail about what changed after writing.',
      reviewerEmail: DEMO_ADMIN_EMAIL,
      at: '2026-01-13T09:30:00.000Z',
    },
    {
      id: 'seed:event:cy-money-verified',
      submissionId: 'seed:submission:cy-money',
      accountId: 'seed:account:cy',
      status: 'verified',
      feedback: 'Verified.',
      reviewerEmail: DEMO_ADMIN_EMAIL,
      at: '2026-01-10T16:20:00.000Z',
    },
  ];

  const pins = [
    { submissionId: 'seed:submission:ada-breath', accountId: 'seed:account:ada', at: '2026-01-09T11:00:00.000Z' },
    { submissionId: 'seed:submission:cy-money', accountId: 'seed:account:cy', at: '2026-01-11T08:00:00.000Z' },
  ];

  const stats = [
    {
      accountId: 'seed:account:ada',
      pages: {
        Breath: { count: 4, firstAt: '2026-01-05T09:05:00.000Z', lastAt: '2026-01-12T08:00:00.000Z' },
        Movement: { count: 2, firstAt: '2026-01-06T07:30:00.000Z', lastAt: '2026-01-12T18:30:00.000Z' },
        'Base Note': { count: 1, firstAt: '2026-01-05T09:02:00.000Z', lastAt: '2026-01-05T09:02:00.000Z' },
      },
      activeMs: 38 * 60 * 1000,
      updatedAt: '2026-01-12T18:30:00.000Z',
      synthetic: true,
    },
    {
      accountId: 'seed:account:ben',
      pages: {
        Reflection: { count: 5, firstAt: '2026-01-06T09:10:00.000Z', lastAt: '2026-01-13T09:00:00.000Z' },
        'Mental Health': { count: 3, firstAt: '2026-01-06T09:12:00.000Z', lastAt: '2026-01-11T20:00:00.000Z' },
      },
      activeMs: 21 * 60 * 1000,
      updatedAt: '2026-01-13T09:00:00.000Z',
      synthetic: true,
    },
    {
      accountId: 'seed:account:cy',
      pages: {
        'Money check-in': { count: 3, firstAt: '2026-01-07T09:20:00.000Z', lastAt: '2026-01-10T07:40:00.000Z' },
        'financial wellness': { count: 2, firstAt: '2026-01-07T09:25:00.000Z', lastAt: '2026-01-09T21:00:00.000Z' },
      },
      activeMs: 15 * 60 * 1000,
      updatedAt: '2026-01-10T07:40:00.000Z',
      synthetic: true,
    },
  ];

  return { accounts, submissions, evidence, reviewEvents, pins, stats };
}
