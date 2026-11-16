/**
 * Domain, persistence and measurement tests for the browser-only demo.
 *
 * `fake-indexeddb` gives the store a real IndexedDB implementation in Node, so
 * these tests exercise the same transactions the browser will run: atomic
 * writes, rollbacks on failure, index lookups and blob round-trips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_LIMITS,
  DEMO_VERIFICATION_CODE,
  addActiveTime,
  applyReview,
  canPreviewEvidence,
  countByStatus,
  createId,
  demoPaneLabel,
  formatBytes,
  formatDuration,
  isAdminEmail,
  isDemoPaneId,
  orderSubmissions,
  recordView,
  seedFixtures,
  summarizeStats,
  validateEmail,
  validateEvidenceFiles,
  validateFeedback,
  validateSubmissionInput,
  validateVerificationCode,
} from '../reader/public/demo-model.js';
import {
  DemoStorageError,
  DemoStorageFullError,
  DemoStorageUnavailableError,
  DemoValidationError,
  createDemoStore,
  mapStorageError,
} from '../reader/public/demo-store.js';
import {
  createReadingTracker,
  shouldCountTime,
  shouldCountView,
} from '../reader/public/demo-tracking.js';
import { createPaneRenderGuard } from '../reader/public/demo-ui.js';

function freshStore() {
  return createDemoStore({ factory: new IDBFactory() });
}

/** Make the next write to one object store fail, the way a full disk would. */
function failStoreWrites(storeName, makeError) {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    if (this.name === storeName) throw makeError();
    return original.apply(this, args);
  };
  return () => {
    IDBObjectStore.prototype.put = original;
  };
}

/* ------------------------------------------------------------ the model --- */

test('only a boolean activity:true is treated as an activity pane id', () => {
  assert.equal(isDemoPaneId('demo:account'), true);
  assert.equal(isDemoPaneId('demo:admin'), true);
  assert.equal(isDemoPaneId('Breath'), false);
  assert.equal(demoPaneLabel('demo:account'), 'User info');
  assert.equal(demoPaneLabel('demo:admin'), 'Admin');
  assert.equal(demoPaneLabel('Breath'), null);
});

test('sign-in validation accepts any address and rejects junk', () => {
  assert.equal(validateEmail('  Ada@Example.COM '), null);
  assert.equal(validateEmail(''), 'Enter an email address for this browser-local account.');
  assert.equal(validateEmail('ada@'), 'That does not look like an email address.');
  assert.match(validateEmail(`${'a'.repeat(300)}@example.com`), /too long/);
  assert.equal(validateVerificationCode(DEMO_VERIFICATION_CODE), null);
  assert.match(validateVerificationCode('000000'), /does not match/);
  assert.equal(isAdminEmail(DEMO_ADMIN_EMAIL), true);
  assert.equal(isAdminEmail(' Admin@Vitruvian.Demo '), true);
});

test('a submission needs a trimmed reflection or a file, and respects the limits', () => {
  const empty = validateSubmissionInput({ reflection: '   ', files: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.summary, /Add a reflection or attach a file/);

  const reflectionOnly = validateSubmissionInput({ reflection: '  Two breaths.  ', files: [] });
  assert.equal(reflectionOnly.ok, true);
  assert.equal(reflectionOnly.reflection, 'Two breaths.');

  const fileOnly = validateSubmissionInput({
    reflection: '',
    files: [{ name: 'note.txt', type: 'text/plain', size: 12 }],
  });
  assert.equal(fileOnly.ok, true);

  const tooMany = validateSubmissionInput({
    reflection: 'x',
    files: Array.from({ length: DEMO_LIMITS.maxEvidenceFiles + 1 }, (_, index) => (
      { name: `f${index}.txt`, type: 'text/plain', size: 10 }
    )),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.evidence, /at most/);

  assert.match(
    validateEvidenceFiles([{ name: 'big.bin', type: 'application/octet-stream', size: DEMO_LIMITS.maxEvidenceFileBytes + 1 }]),
    /larger than/,
  );
  assert.match(validateEvidenceFiles([{ name: 'empty.txt', type: 'text/plain', size: 0 }]), /is empty/);
  assert.match(
    validateEvidenceFiles([
      { name: 'a.bin', type: 'application/octet-stream', size: DEMO_LIMITS.maxEvidenceFileBytes },
      { name: 'b.bin', type: 'application/octet-stream', size: DEMO_LIMITS.maxEvidenceFileBytes * 0.75 },
      { name: 'c.bin', type: 'application/octet-stream', size: DEMO_LIMITS.maxEvidenceFileBytes * 0.5 },
    ]),
    /total more than/,
  );

  const long = validateSubmissionInput({ reflection: 'x'.repeat(DEMO_LIMITS.maxReflectionLength + 1), files: [] });
  assert.equal(long.ok, false);
  assert.match(long.errors.reflection, /under/);
});

test('only allow-listed image types may be previewed', () => {
  assert.equal(canPreviewEvidence('image/png'), true);
  assert.equal(canPreviewEvidence('image/avif'), true);
  assert.equal(canPreviewEvidence('image/svg+xml'), false);
  assert.equal(canPreviewEvidence('text/html'), false);
  assert.equal(canPreviewEvidence('application/pdf'), false);
});

test('review transitions carry a timestamped history event', () => {
  const base = {
    id: 's1', accountId: 'a1', noteId: 'Breath', noteTitle: 'Breath',
    reflection: 'x', evidence: [], status: 'pending',
    createdAt: '2026-02-01T09:00:00.000Z', updatedAt: '2026-02-01T09:00:00.000Z',
    reviewedAt: null, reviewedBy: null, lastFeedback: null,
  };
  const changes = applyReview(base, {
    status: 'changes_requested',
    feedback: '  Say more.  ',
    reviewerEmail: DEMO_ADMIN_EMAIL,
    at: '2026-02-02T10:00:00.000Z',
    eventId: 'e1',
  });
  assert.equal(changes.submission.status, 'changes_requested');
  assert.equal(changes.submission.lastFeedback, 'Say more.');
  assert.equal(changes.submission.reviewedBy, DEMO_ADMIN_EMAIL);
  assert.equal(changes.event.at, '2026-02-02T10:00:00.000Z');
  assert.equal(changes.event.submissionId, 's1');

  const verified = applyReview(changes.submission, {
    status: 'verified', feedback: '', reviewerEmail: DEMO_ADMIN_EMAIL,
    at: '2026-02-03T10:00:00.000Z', eventId: 'e2',
  });
  assert.equal(verified.submission.status, 'verified');
  assert.equal(verified.submission.lastFeedback, null);
  assert.throws(() => applyReview(base, { status: 'approved', at: 'x', eventId: 'e3' }), TypeError);

  assert.equal(validateFeedback('', { required: true }), 'Add feedback when requesting changes.');
  assert.equal(validateFeedback('', { required: false }), null);
});

test('pinned submissions come first, and stay in the history too', () => {
  const submissions = [
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-01-03T00:00:00.000Z' },
  ];
  const pins = new Map([['a', { submissionId: 'a', at: '2026-01-04T00:00:00.000Z' }]]);
  const ordered = orderSubmissions(submissions, pins);
  assert.deepEqual(ordered.map((item) => item.id), ['a', 'c', 'b']);
  assert.equal(ordered[0].pinned, true);
  assert.equal(ordered.length, 3);
  assert.deepEqual(countByStatus([
    { status: 'pending' }, { status: 'verified' }, { status: 'verified' }, { status: 'nonsense' },
  ]), { pending: 1, verified: 2, changes_requested: 0, total: 4 });
});

test('reading statistics count distinct pages, not visits', () => {
  let stats = recordView(null, 'Breath', '2026-01-01T00:00:00.000Z');
  stats = recordView(stats, 'Breath', '2026-01-02T00:00:00.000Z');
  stats = recordView(stats, 'Movement', '2026-01-03T00:00:00.000Z');
  stats = addActiveTime(stats, 1500, '2026-01-03T00:00:00.000Z');
  stats = addActiveTime(stats, -20, '2026-01-03T00:00:00.000Z');
  const summary = summarizeStats(stats);
  assert.equal(summary.pagesExplored, 2);
  assert.equal(summary.views, 3);
  assert.equal(summary.activeMs, 1500);
  assert.equal(stats.pages.Breath.firstAt, '2026-01-01T00:00:00.000Z');
  assert.equal(formatDuration(1500), '2s');
  assert.equal(formatDuration(90 * 60 * 1000), '1h 30m');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

test('ids fall back when randomUUID is unavailable, as on a plain-HTTP host', () => {
  assert.match(createId('account', undefined), /^account:/);
  assert.equal(createId('account', () => 'fixed'), 'account:fixed');
});

/* -------------------------------------------------------------- the store --- */

test('signing in creates one account per address and remembers the session', async () => {
  const store = freshStore();
  const first = await store.signIn('  Ada@Example.com ');
  assert.equal(first.created, true);
  assert.equal(first.account.email, 'ada@example.com');
  assert.equal(first.account.synthetic, false);

  const again = await store.signIn('ada@example.com');
  assert.equal(again.created, false);
  assert.equal(again.account.id, first.account.id);

  assert.equal(await store.readSession(), null);
  await store.writeSession(first.account.id);
  assert.equal((await store.readSession()).id, first.account.id);
  await store.writeSession(null);
  assert.equal(await store.readSession(), null);

  await assert.rejects(() => store.signIn('not-an-address'), (error) => {
    assert.ok(error instanceof DemoValidationError);
    assert.match(error.errors.email, /does not look like an email/);
    return true;
  });
});

test('a submission lands pending with its evidence, and is isolated per account', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;
  const ben = (await store.signIn('ben@example.com')).account;

  const bytes = new TextEncoder().encode('two breaths').buffer;
  const { submission } = await store.createSubmission({
    accountId: ada.id,
    noteId: 'Breath',
    noteTitle: 'Breath',
    reflection: '  Did it.  ',
    evidence: [{ name: 'notes.txt', type: 'text/plain', size: bytes.byteLength, bytes }],
  });
  assert.equal(submission.status, 'pending');
  assert.equal(submission.reflection, 'Did it.');
  assert.equal(submission.evidence.length, 1);
  assert.equal(submission.evidence[0].size, bytes.byteLength);

  const evidence = await store.listEvidence(submission.id);
  assert.equal(evidence.length, 1);
  assert.equal(new TextDecoder().decode(evidence[0].bytes), 'two breaths');
  assert.equal(evidence[0].submissionId, submission.id);

  assert.equal((await store.listSubmissions({ accountId: ada.id })).length, 1);
  assert.equal((await store.listSubmissions({ accountId: ben.id })).length, 0);

  await assert.rejects(
    () => store.setPin(ben.id, submission.id, true),
    (error) => error instanceof DemoValidationError && /author/.test(error.message),
  );
  await assert.rejects(
    () => store.createSubmission({ accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: ' ', evidence: [] }),
    (error) => error instanceof DemoValidationError && /could not be saved/.test(error.message),
  );
});

test('pins persist, survive a reload, and never leave the history', async () => {
  const factory = new IDBFactory();
  const first = createDemoStore({ factory });
  const ada = (await first.signIn('ada@example.com')).account;
  const older = (await first.createSubmission({
    accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'older',
    at: '2026-03-01T00:00:00.000Z',
  })).submission;
  await first.createSubmission({
    accountId: ada.id, noteId: 'Movement', noteTitle: 'Movement', reflection: 'newer',
    at: '2026-03-02T00:00:00.000Z',
  });

  await first.setPin(ada.id, older.id, true);

  // A new store over the same database is what a reload looks like.
  const second = createDemoStore({ factory });
  const listed = await second.listSubmissions({ accountId: ada.id });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, older.id);
  assert.equal(listed[0].pinned, true);
  assert.equal(listed[1].pinned, false);

  await second.setPin(ada.id, older.id, false);
  const after = await second.listSubmissions({ accountId: ada.id });
  assert.equal(after[0].id !== older.id || after[0].pinned === false, true);
  assert.equal(after.filter((item) => item.pinned).length, 0);
  assert.equal(after.length, 2);
});

test('a review updates the status and appends one history event', async () => {
  const store = freshStore();
  const admin = (await store.signIn(DEMO_ADMIN_EMAIL)).account;
  const ada = (await store.signIn('ada@example.com')).account;
  const { submission } = await store.createSubmission({
    accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'first pass',
  });

  await assert.rejects(
    () => store.reviewSubmission({ submissionId: submission.id, status: 'changes_requested', feedback: '  ', reviewerEmail: admin.email }),
    (error) => error instanceof DemoValidationError && /feedback/.test(error.message),
  );
  await assert.rejects(
    () => store.reviewSubmission({ submissionId: submission.id, status: 'approved', reviewerEmail: admin.email }),
    (error) => error instanceof DemoValidationError && /three review states/.test(error.message),
  );

  const requested = await store.reviewSubmission({
    submissionId: submission.id,
    status: 'changes_requested',
    feedback: 'Say more.',
    reviewerEmail: admin.email,
    at: '2026-04-01T10:00:00.000Z',
  });
  assert.equal(requested.submission.status, 'changes_requested');
  assert.equal(requested.event.feedback, 'Say more.');

  const verified = await store.reviewSubmission({
    submissionId: submission.id,
    status: 'verified',
    feedback: 'Good.',
    reviewerEmail: admin.email,
    at: '2026-04-02T10:00:00.000Z',
  });
  assert.equal(verified.submission.status, 'verified');

  const events = await store.listReviewEvents(submission.id);
  assert.deepEqual(events.map((event) => event.status), ['changes_requested', 'verified']);
  assert.deepEqual(events.map((event) => event.at), ['2026-04-01T10:00:00.000Z', '2026-04-02T10:00:00.000Z']);

  const reread = await store.getSubmission(submission.id);
  assert.equal(reread.status, 'verified');
  assert.equal(reread.reviewedBy, DEMO_ADMIN_EMAIL);
});

test('seeding is idempotent and clearly labelled synthetic', async () => {
  const store = freshStore();
  assert.deepEqual(await store.seedIfNeeded(), { seeded: true });
  const accounts = await store.listAccounts();
  const submissions = await store.listSubmissions();
  const stats = await store.listStats();

  assert.ok(accounts.length >= 3);
  assert.ok(submissions.length >= 4);
  assert.ok(accounts.every((account) => account.synthetic === true));
  assert.ok(stats.every((record) => record.synthetic === true));
  const seededIds = new Set(accounts.map((account) => account.id));
  assert.ok(submissions.every((submission) => seededIds.has(submission.accountId)));
  assert.ok(submissions.some((submission) => submission.status === 'verified'));
  assert.ok(submissions.some((submission) => submission.status === 'pending'));
  assert.ok(submissions.some((submission) => submission.status === 'changes_requested'));
  assert.ok(submissions.some((submission) => submission.pinned));

  const before = submissions.length;
  assert.deepEqual(await store.seedIfNeeded(), { seeded: false });
  assert.equal((await store.listSubmissions()).length, before);

  // Seeded evidence is retrievable, so the admin page can show it.
  const withEvidence = submissions.find((submission) => submission.evidence.length > 0);
  const records = await store.listEvidence(withEvidence.id);
  assert.ok(records.length > 0);
  assert.match(new TextDecoder().decode(records[0].bytes), /Synthetic fixture/);

  const fixtures = seedFixtures();
  assert.equal(fixtures.accounts.every((account) => account.synthetic === true), true);
});

test('a failed evidence write leaves no half-saved submission behind', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;

  const restore = failStoreWrites('evidence', () => new DOMException('simulated clone failure', 'DataCloneError'));
  try {
    await assert.rejects(
      () => store.createSubmission({
        accountId: ada.id,
        noteId: 'Breath',
        noteTitle: 'Breath',
        reflection: 'should not survive',
        evidence: [{ name: 'a.txt', type: 'text/plain', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer }],
      }),
      (error) => error.code === 'STORAGE_ERROR',
    );
  } finally {
    restore();
  }

  assert.deepEqual(await store.listSubmissions({ accountId: ada.id }), []);
  assert.deepEqual(await store.listEvidence('anything'), []);
});

test('a full browser is reported as full, not silently ignored', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;
  const restore = failStoreWrites('submissions', () => new DOMException('simulated quota', 'QuotaExceededError'));
  try {
    await assert.rejects(
      () => store.createSubmission({ accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'x' }),
      (error) => {
        assert.ok(error instanceof DemoStorageFullError);
        assert.match(error.message, /no room left/);
        return true;
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(await store.listSubmissions({ accountId: ada.id }), []);
});

test('without IndexedDB the demo reports itself unavailable instead of falling back', async () => {
  const store = createDemoStore({ factory: null });
  await assert.rejects(() => store.open(), (error) => {
    assert.ok(error instanceof DemoStorageUnavailableError);
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    return true;
  });
  await assert.rejects(() => store.listAccounts(), (error) => error instanceof DemoStorageUnavailableError);
  await assert.rejects(() => store.seedIfNeeded(), (error) => error instanceof DemoStorageUnavailableError);

  assert.equal(mapStorageError(new DOMException('x', 'QuotaExceededError')).code, 'STORAGE_FULL');
  assert.equal(mapStorageError(new DOMException('x', 'SecurityError')).code, 'STORAGE_UNAVAILABLE');
  assert.equal(mapStorageError(new Error('other')).code, 'STORAGE_ERROR');
  const passthrough = new DemoValidationError('nope', {});
  assert.equal(mapStorageError(passthrough), passthrough);
});

test('reading statistics are written per account and only for real notes', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;
  await store.recordNoteView(ada.id, 'Breath', '2026-05-01T10:00:00.000Z');
  await store.recordNoteView(ada.id, 'Breath', '2026-05-01T10:05:00.000Z');
  await store.recordNoteView(ada.id, 'Movement', '2026-05-01T10:06:00.000Z');
  await store.addActiveTime(ada.id, 4000, '2026-05-01T10:06:00.000Z');

  const stats = await store.getStats(ada.id);
  assert.equal(summarizeStats(stats).pagesExplored, 2);
  assert.equal(summarizeStats(stats).views, 3);
  assert.equal(stats.activeMs, 4000);

  // A missing account is a no-op rather than a crash.
  assert.equal(await store.recordNoteView(null, 'Breath'), null);
  assert.equal((await store.getStats('nobody')).activeMs, 0);
});

test('clearing local data removes local accounts and restores the fixtures', async () => {
  const store = freshStore();
  await store.seedIfNeeded();
  const ada = (await store.signIn('ada@example.com')).account;
  await store.createSubmission({ accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'mine' });
  await store.recordNoteView(ada.id, 'Breath');
  await store.writeSession(ada.id);

  await store.resetAll();

  assert.equal(await store.readSession(), null);
  const accounts = await store.listAccounts();
  assert.equal(accounts.some((account) => account.email === 'ada@example.com'), false);
  assert.ok(accounts.every((account) => account.synthetic === true));
  assert.ok((await store.listSubmissions()).every((submission) => submission.accountId !== ada.id));
  assert.equal((await store.getStats(ada.id)).activeMs, 0);
});

test('an asynchronous request failure is mapped, not swallowed', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;

  // A request that fails through its error event, rather than a synchronous
  // throw from `put`, is the shape a full disk actually takes.
  const original = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function patchedGet(...args) {
    if (this.name !== 'stats') return original.apply(this, args);
    const fake = {};
    queueMicrotask(() => {
      fake.error = new DOMException('simulated quota', 'QuotaExceededError');
      fake.onerror?.({ target: fake });
    });
    return fake;
  };
  try {
    await assert.rejects(
      () => store.addActiveTime(ada.id, 1_000),
      (error) => {
        assert.ok(error instanceof DemoStorageFullError);
        assert.match(error.message, /no room left/);
        return true;
      },
    );
  } finally {
    IDBObjectStore.prototype.get = original;
  }

  assert.equal((await store.getStats(ada.id)).activeMs, 0);
});

test('an aborted transaction is reported and leaves nothing behind', async () => {
  const store = freshStore();
  const ada = (await store.signIn('ada@example.com')).account;

  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patchedPut(...args) {
    const request = original.apply(this, args);
    if (this.name === 'submissions') {
      const transaction = this.transaction;
      queueMicrotask(() => {
        try {
          transaction.abort();
        } catch {
          /* already finished */
        }
      });
    }
    return request;
  };
  try {
    await assert.rejects(
      () => store.createSubmission({ accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'x' }),
      (error) => error instanceof DemoStorageError,
    );
  } finally {
    IDBObjectStore.prototype.put = original;
  }

  assert.deepEqual(await store.listSubmissions({ accountId: ada.id }), []);
});

test('a failed reset aborts as a whole instead of half-clearing the demo', async () => {
  const store = freshStore();
  await store.seedIfNeeded();
  const ada = (await store.signIn('ada@example.com')).account;
  await store.createSubmission({ accountId: ada.id, noteId: 'Breath', noteTitle: 'Breath', reflection: 'mine' });
  await store.writeSession(ada.id);

  const restore = failStoreWrites('accounts', () => new DOMException('simulated', 'UnknownError'));
  try {
    await assert.rejects(() => store.resetAll());
  } finally {
    restore();
  }

  // The clear and the re-seed shared one transaction, so both rolled back.
  assert.equal((await store.readSession()).id, ada.id);
  assert.equal((await store.listSubmissions({ accountId: ada.id })).length, 1);
  assert.ok((await store.listAccounts()).some((account) => account.email === 'ada@example.com'));
  assert.ok((await store.listSubmissions()).some((submission) => submission.id.startsWith('seed:')));
});

/* --------------------------------------------------------- the measuring --- */

test('the counting rules exclude previews, failures, hidden tabs and demo panes', () => {
  const rendered = true;
  assert.equal(shouldCountView({ signedIn: true, activeNoteId: 'Breath', isRendered: rendered, paused: false }), true);
  assert.equal(shouldCountView({ signedIn: false, activeNoteId: 'Breath', isRendered: rendered, paused: false }), false);
  assert.equal(shouldCountView({ signedIn: true, activeNoteId: 'Breath', isRendered: false, paused: false }), false);
  assert.equal(shouldCountView({ signedIn: true, activeNoteId: null, isRendered: rendered, paused: false }), false);
  assert.equal(shouldCountView({ signedIn: true, activeNoteId: 'Breath', isRendered: rendered, paused: true }), false);

  const base = { signedIn: true, activeNoteId: 'Breath', isRendered: rendered, visible: true, idle: false, paused: false };
  assert.equal(shouldCountTime(base), true);
  assert.equal(shouldCountTime({ ...base, visible: false }), false);
  assert.equal(shouldCountTime({ ...base, idle: true }), false);
  assert.equal(shouldCountTime({ ...base, paused: true }), false);
  assert.equal(shouldCountTime({ ...base, activeNoteId: 'demo:account' }), false);
});

test('the tracker counts a page once, bounds long gaps, and flushes on sign-out', () => {
  let clock = 1_000_000;
  const views = [];
  const times = [];
  const tracker = createReadingTracker({
    now: () => clock,
    idleMs: 10_000,
    maxStepMs: 1_000,
    flushMs: 100_000,
    onView: (id) => views.push(id),
    onTime: (ms) => times.push(ms),
  });

  // A note that has not rendered is not a page, and a signed-out reader is not measured.
  tracker.setActiveNote('Breath');
  tracker.setSignedIn(true);
  assert.deepEqual(views, []);
  tracker.markRendered('Breath');
  assert.deepEqual(views, ['Breath']);

  // Rebuilding the same pane is not a new page.
  tracker.clearRendered();
  tracker.markRendered('Breath');
  assert.deepEqual(views, ['Breath']);
  assert.equal(tracker.snapshot().counting, true);

  clock += 1_000;
  tracker.tick(clock);
  clock += 1_000;
  tracker.tick(clock);
  // A suspended tab cannot bill the reader for the whole gap.
  clock += 60_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 3_000);

  tracker.setVisible(false);
  clock += 1_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 3_000);
  tracker.setVisible(true);

  tracker.setPaused(true);
  clock += 1_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 3_000);
  assert.equal(tracker.snapshot().counting, false);
  tracker.setPaused(false);

  // Leaving the note for a demo pane stops the clock and persists the stretch
  // immediately, so a short visit is never left unmeasured.
  tracker.setActiveNote(null);
  assert.equal(tracker.snapshot().pendingMs, 0);
  assert.deepEqual(times, [3_000]);
  clock += 1_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().counting, false);

  // Coming back is a new visit, and signing out hands over the measured time.
  // The reader has to be present again first: the long gap above made them idle.
  tracker.noteInteraction(clock);
  tracker.setActiveNote('Breath');
  clock += 1_000;
  tracker.tick(clock);
  assert.deepEqual(views, ['Breath', 'Breath']);
  tracker.setSignedIn(false);
  assert.deepEqual(times, [3_000, 1_000]);
  assert.equal(tracker.snapshot().pendingMs, 0);

  // Idle time is not measured either.
  tracker.setSignedIn(true);
  tracker.noteInteraction(clock);
  clock += 1_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 1_000);
  // Idle time is not measured either: the tick that notices the reader has gone
  // credits at most one bounded step, never the whole 30 seconds.
  tracker.noteInteraction(clock);
  clock += 30_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 2_000);
  assert.equal(tracker.snapshot().counting, false);
});

test('leaving a measured note persists a short stretch immediately', () => {
  let clock = 500_000;
  const times = [];
  const tracker = createReadingTracker({
    now: () => clock,
    idleMs: 60_000,
    maxStepMs: 30_000,
    flushMs: 20_000,
    onTime: (ms) => times.push(ms),
  });

  tracker.setSignedIn(true);
  tracker.setActiveNote('Breath');
  tracker.markRendered('Breath');
  clock += 8_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 8_000);
  assert.deepEqual(times, [], 'below the flush threshold nothing is written yet');

  // Opening a demo pane leaves the note: the short stretch is handed over now.
  tracker.setActiveNote('demo:account');
  assert.deepEqual(times, [8_000]);
  assert.equal(tracker.snapshot().pendingMs, 0);

  // A reset discards whatever is still pending instead of writing it.
  tracker.setActiveNote('Breath');
  clock += 3_000;
  tracker.tick(clock);
  assert.equal(tracker.snapshot().pendingMs, 3_000);
  tracker.discard();
  assert.equal(tracker.snapshot().pendingMs, 0);
  tracker.settle();
  assert.deepEqual(times, [8_000]);
});

test('overlapping pane loads are ordered, and a stale session cannot commit', () => {
  const guard = createPaneRenderGuard();
  const pane = {};

  const first = guard.begin(pane, 'account-a');
  assert.equal(first.isCurrent('account-a'), true);

  const second = guard.begin(pane, 'account-a');
  assert.equal(first.isCurrent('account-a'), false, 'the older load of the same pane is stale');
  assert.equal(second.isCurrent('account-a'), true);
  assert.equal(second.isCurrent('account-b'), false, 'a load from another session is stale');
  assert.equal(second.isCurrent(null), false);

  const otherPane = {};
  const third = guard.begin(otherPane, null);
  assert.equal(third.isCurrent(null), true, 'a different pane has its own generation');
  assert.equal(second.isCurrent('account-a'), true, 'another pane does not invalidate this one');
});

test('the tracker stops cleanly and never flushes for a signed-out reader', () => {
  const times = [];
  const cleared = [];
  const tracker = createReadingTracker({
    now: () => 0,
    setInterval: (fn, ms) => {
      assert.equal(typeof fn, 'function');
      assert.ok(ms > 0);
      return 7;
    },
    clearInterval: (id) => cleared.push(id),
    onTime: (ms) => times.push(ms),
  });
  tracker.start();
  tracker.start();
  tracker.dispose();
  assert.deepEqual(cleared, [7]);
  assert.deepEqual(times, []);
});
