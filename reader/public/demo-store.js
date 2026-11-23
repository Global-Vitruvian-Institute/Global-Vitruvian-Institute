/**
 * demo-store.js — IndexedDB persistence for the local participation demo.
 *
 * Everything the demo knows lives in one versioned, origin-scoped database. The
 * API is deliberately small and always asynchronous, and it never falls back to
 * `localStorage`: a silent, unbounded substitute would hide the one limitation
 * the demo is supposed to make obvious.
 *
 * Writes that must not half-happen (a submission and its evidence, a review and
 * its history event) share a single transaction. Callers get mapped errors, not
 * raw DOMExceptions.
 */
import {
  DEMO_ADMIN_EMAIL,
  addActiveTime as accumulateActiveTime,
  applyReview,
  createId,
  createSubmissionRecord,
  emptyStats,
  normalizeEmail,
  orderSubmissions,
  recordView as accumulateView,
  seedFixtures,
  validateEmail,
  validateFeedback,
  validateSubmissionInput,
  isSubmissionStatus,
} from './demo-model.js';

export const DEMO_DB_NAME = 'vitruvian-demo';
export const DEMO_DB_VERSION = 1;
/** Bump to re-seed a browser that already carries an older fixture set. */
export const DEMO_SEED_VERSION = 1;

export const DEMO_STORE_NAMES = Object.freeze([
  'accounts', 'submissions', 'evidence', 'reviewEvents', 'pins', 'stats', 'meta',
]);

export class DemoStorageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DemoStorageError';
    this.code = options.code ?? 'STORAGE_ERROR';
    this.cause = options.cause;
  }
}

export class DemoStorageUnavailableError extends DemoStorageError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'STORAGE_UNAVAILABLE' });
    this.name = 'DemoStorageUnavailableError';
  }
}

export class DemoStorageFullError extends DemoStorageError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'STORAGE_FULL' });
    this.name = 'DemoStorageFullError';
  }
}

export class DemoValidationError extends DemoStorageError {
  constructor(message, errors = {}, options = {}) {
    super(message, { ...options, code: 'VALIDATION' });
    this.name = 'DemoValidationError';
    this.errors = errors;
  }
}

/** One place where browser errors become messages the reader can act on. */
export function mapStorageError(error) {
  if (error instanceof DemoStorageError) return error;
  const name = error?.name;
  if (name === 'QuotaExceededError') {
    return new DemoStorageFullError(
      'This browser has no room left for the demo. Clear local demo data from User, then try again.',
      { cause: error },
    );
  }
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') {
    return new DemoStorageUnavailableError(
      'This browser refused access to local storage, so the demo cannot save anything here.',
      { cause: error },
    );
  }
  if (name === 'DataCloneError') {
    return new DemoStorageError('That file could not be stored in this browser.', { cause: error });
  }
  return new DemoStorageError(
    error?.message || 'Local storage failed while handling this demo action.',
    { cause: error },
  );
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('The browser rejected that storage request.'));
  });
}

/**
 * Run one transaction. `work` issues its requests synchronously (or from within
 * an earlier request's success handler) and may return a promise for its result.
 *
 * A returned promise is observed the moment it is handed back, not when the
 * transaction happens to finish. An asynchronous request error or a rejected
 * work promise must abort the transaction and surface as the mapped storage
 * error, and success is only reported once both the work and the commit have
 * succeeded.
 */
function runTransaction(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      reject(mapStorageError(error));
      return;
    }

    let settled = false;
    let committed = false;
    let workSettled = false;
    let result;
    let abortReason = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(mapStorageError(error));
      else resolve(result);
    };

    const abortWith = (error) => {
      abortReason = abortReason ?? error;
      try {
        tx.abort();
      } catch {
        // The transaction already finished; the error is still the outcome.
        finish(abortReason);
      }
    };

    tx.onerror = () => {
      // The abort that follows carries the reason; nothing may be committed.
      abortReason = abortReason ?? tx.error;
    };
    tx.onabort = () => finish(abortReason ?? tx.error ?? new Error('The browser cancelled this write.'));
    tx.oncomplete = () => {
      committed = true;
      if (workSettled) finish(null);
    };

    try {
      const returned = work(tx);
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (value) => {
            result = value;
            workSettled = true;
            if (committed) finish(null);
          },
          (error) => {
            // An asynchronous request failure or a rejected work promise: the
            // transaction must not commit, and the reader gets the mapped error.
            workSettled = true;
            finish(error);
            abortWith(error);
          },
        );
      } else {
        result = returned;
        workSettled = true;
      }
    } catch (error) {
      // A synchronous throw (DataCloneError, a bad key) leaves the transaction
      // open; abort it so a half-written submission cannot survive.
      workSettled = true;
      finish(error);
      abortWith(error);
    }
  });
}

function toBytes(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new DemoStorageError('Evidence must be stored as raw bytes.');
}

export function createDemoStore({
  factory = globalThis.indexedDB,
  name = DEMO_DB_NAME,
  version = DEMO_DB_VERSION,
  randomUUID = globalThis.crypto?.randomUUID,
} = {}) {
  let dbPromise = null;
  let db = null;

  function upgrade(database) {
    if (!database.objectStoreNames.contains('accounts')) {
      database.createObjectStore('accounts', { keyPath: 'id' }).createIndex('email', 'email', { unique: true });
    }
    if (!database.objectStoreNames.contains('submissions')) {
      const store = database.createObjectStore('submissions', { keyPath: 'id' });
      store.createIndex('accountId', 'accountId');
      store.createIndex('status', 'status');
      store.createIndex('noteId', 'noteId');
    }
    if (!database.objectStoreNames.contains('evidence')) {
      database.createObjectStore('evidence', { keyPath: 'id' }).createIndex('submissionId', 'submissionId');
    }
    if (!database.objectStoreNames.contains('reviewEvents')) {
      database.createObjectStore('reviewEvents', { keyPath: 'id' }).createIndex('submissionId', 'submissionId');
    }
    if (!database.objectStoreNames.contains('pins')) {
      database.createObjectStore('pins', { keyPath: 'submissionId' }).createIndex('accountId', 'accountId');
    }
    if (!database.objectStoreNames.contains('stats')) {
      database.createObjectStore('stats', { keyPath: 'accountId' });
    }
    if (!database.objectStoreNames.contains('meta')) {
      database.createObjectStore('meta', { keyPath: 'key' });
    }
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!factory || typeof factory.open !== 'function') {
        reject(new DemoStorageUnavailableError(
          'This browser did not provide IndexedDB, so the demo cannot store accounts or submissions.',
        ));
        return;
      }
      let req;
      try {
        req = factory.open(name, version);
      } catch (error) {
        reject(mapStorageError(error));
        return;
      }
      req.onupgradeneeded = () => upgrade(req.result);
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* nothing left to close */
          }
        };
        resolve(db);
      };
      req.onerror = () => reject(mapStorageError(req.error));
      req.onblocked = () => reject(new DemoStorageUnavailableError(
        'Another tab is holding an older version of this demo database. Close it and reload.',
      ));
    });
    return dbPromise;
  }

  async function readAll(storeName, { index, query } = {}) {
    const database = await open();
    return runTransaction(database, [storeName], 'readonly', (tx) => {
      const store = tx.objectStore(storeName);
      const target = index ? store.index(index) : store;
      return request(query === undefined ? target.getAll() : target.getAll(query));
    });
  }

  async function readOne(storeName, key) {
    const database = await open();
    return runTransaction(database, [storeName], 'readonly', (tx) =>
      request(tx.objectStore(storeName).get(key)));
  }

  async function putRecords(stores, write) {
    const database = await open();
    return runTransaction(database, stores, 'readwrite', (tx) => write(tx));
  }

  async function getMeta(key) {
    return (await readOne('meta', key)) ?? null;
  }

  async function setMeta(key, value) {
    await putRecords(['meta'], (tx) => {
      tx.objectStore('meta').put({ key, value });
    });
  }

  async function listAccounts() {
    const accounts = await readAll('accounts');
    return accounts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * Signing in is creating the account if it is new. There is no password and no
   * verification beyond the on-screen code; the caller checks that code.
   */
  /** The demo sends nothing; the on-screen code does the work. */
  async function sendCode() {
    return { sent: false };
  }

  async function signIn(email, code) {
    const problem = validateEmail(email);
    if (problem) throw new DemoValidationError(problem, { email: problem });
    const normalized = normalizeEmail(email);
    const found = (await readAll('accounts', { index: 'email', query: normalized }))[0];
    if (found) return { account: found, created: false };

    const account = {
      id: createId('account', randomUUID),
      email: normalized,
      displayName: normalized.split('@')[0].slice(0, 60) || 'Reader',
      role: normalized === 'admin@vitruvian.demo' ? 'admin' : 'participant',
      synthetic: false,
      createdAt: new Date().toISOString(),
    };
    try {
      await putRecords(['accounts'], (tx) => {
        tx.objectStore('accounts').add(account);
      });
    } catch (error) {
      // Another tab won the race for the same address; its account is the one.
      const existing = (await readAll('accounts', { index: 'email', query: normalized }))[0];
      if (existing) return { account: existing, created: false };
      throw error;
    }
    return { account, created: true };
  }

  async function readSession() {
    const marker = await getMeta('sessionAccountId');
    if (!marker?.value) return null;
    return (await readOne('accounts', marker.value)) ?? null;
  }

  async function writeSession(accountId) {
    await setMeta('sessionAccountId', accountId ?? null);
  }

  async function pinMap() {
    const pins = await readAll('pins');
    return new Map(pins.map((pin) => [pin.submissionId, pin]));
  }

  async function listSubmissions({ accountId } = {}) {
    const [submissions, pins] = await Promise.all([
      readAll('submissions', accountId ? { index: 'accountId', query: accountId } : {}),
      pinMap(),
    ]);
    return orderSubmissions(submissions, pins);
  }

  async function getSubmission(id) {
    return (await readOne('submissions', id)) ?? null;
  }

  async function listEvidence(submissionId) {
    const records = await readAll('evidence', { index: 'submissionId', query: submissionId });
    return records.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * The submission row and its evidence land together or not at all: one
   * transaction, so a failure part-way leaves nothing behind to confuse a
   * reviewer.
   */
  async function createSubmission({ accountId, noteId, noteTitle, reflection = '', evidence = [], at }) {
    if (!accountId) throw new DemoValidationError('Sign in before logging an activity.', { account: 'Sign in first.' });
    const descriptors = evidence.map((file) => ({ name: file.name, type: file.type, size: file.size }));
    const checked = validateSubmissionInput({ reflection, files: descriptors });
    if (!checked.ok) {
      throw new DemoValidationError('That submission could not be saved.', checked.errors);
    }

    const timestamp = at ?? new Date().toISOString();
    const submissionId = createId('submission', randomUUID);
    // Bytes are read before the transaction opens: awaiting a File read inside a
    // transaction would let the transaction auto-commit underneath us.
    const records = [];
    for (const file of evidence) {
      const bytes = toBytes(file.bytes);
      records.push({
        id: createId('evidence', randomUUID),
        submissionId,
        name: String(file.name),
        type: String(file.type || 'application/octet-stream'),
        size: bytes.byteLength,
        bytes,
      });
    }

    const submission = createSubmissionRecord({
      id: submissionId,
      accountId,
      noteId,
      noteTitle,
      reflection: checked.reflection,
      evidence: records,
      at: timestamp,
    });

    await putRecords(['submissions', 'evidence'], (tx) => {
      tx.objectStore('submissions').put(submission);
      const evidenceStore = tx.objectStore('evidence');
      for (const record of records) evidenceStore.put(record);
    });

    return { submission, evidence: records };
  }

  /** Status change plus its history event, in one transaction. */
  async function reviewSubmission({ submissionId, status, feedback = '', reviewerEmail, at }) {
    if (!isSubmissionStatus(status)) {
      throw new DemoValidationError('Choose one of the three review states.', { status: 'Unknown review state.' });
    }
    const problem = validateFeedback(feedback, { required: status === 'changes_requested' });
    if (problem) throw new DemoValidationError(problem, { feedback: problem });

    const current = await getSubmission(submissionId);
    if (!current) throw new DemoValidationError('That submission is no longer stored here.', { submission: 'Not found.' });

    const timestamp = at ?? new Date().toISOString();
    const { submission: next, event } = applyReview(current, {
      status,
      feedback,
      reviewerEmail,
      at: timestamp,
      eventId: createId('review', randomUUID),
    });

    await putRecords(['submissions', 'reviewEvents'], (tx) => {
      tx.objectStore('submissions').put(next);
      tx.objectStore('reviewEvents').put(event);
    });

    return { submission: next, event };
  }

  async function listReviewEvents(submissionId) {
    const events = await readAll('reviewEvents', { index: 'submissionId', query: submissionId });
    return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  async function listAllReviewEvents() {
    const events = await readAll('reviewEvents');
    return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }

  /** A reader may pin their own submission whatever its review status. */
  async function setPin(accountId, submissionId, pinned) {
    const submission = await getSubmission(submissionId);
    if (!submission) throw new DemoValidationError('That submission is no longer stored here.', { submission: 'Not found.' });
    if (submission.accountId !== accountId) {
      throw new DemoValidationError('Only the author can pin this submission.', { submission: 'Not yours.' });
    }
    await putRecords(['pins'], (tx) => {
      const store = tx.objectStore('pins');
      if (pinned) store.put({ submissionId, accountId, at: new Date().toISOString() });
      else store.delete(submissionId);
    });
    return pinned;
  }

  async function getStats(accountId) {
    return (await readOne('stats', accountId)) ?? emptyStats(accountId);
  }

  async function listStats() {
    return readAll('stats');
  }

  async function mutateStats(accountId, mutate, at) {
    if (!accountId) return null;
    const timestamp = at ?? new Date().toISOString();
    return putRecords(['stats'], (tx) => new Promise((resolve, reject) => {
      const store = tx.objectStore('stats');
      const get = store.get(accountId);
      get.onerror = () => reject(get.error);
      get.onsuccess = () => {
        const next = mutate(get.result ?? emptyStats(accountId), timestamp);
        const put = store.put(next);
        put.onerror = () => reject(put.error);
        put.onsuccess = () => resolve(next);
      };
    }));
  }

  // The model helpers are aliased above: the store's own `recordNoteView` and
  // `addActiveTime` share their names, and a shadowed call would recurse.
  function recordNoteView(accountId, noteId, at) {
    return mutateStats(accountId, (stats, timestamp) => accumulateView(stats, noteId, timestamp), at);
  }

  function addActiveTime(accountId, ms, at) {
    return mutateStats(accountId, (stats, timestamp) => accumulateActiveTime(stats, ms, timestamp), at);
  }

  /** Write the synthetic fixtures and their marker into an open transaction. */
  function writeFixtures(tx, fixtures) {
    const accounts = tx.objectStore('accounts');
    for (const account of fixtures.accounts) accounts.put(account);
    const submissions = tx.objectStore('submissions');
    for (const submission of fixtures.submissions) submissions.put(submission);
    const evidence = tx.objectStore('evidence');
    for (const record of fixtures.evidence) evidence.put(record);
    const events = tx.objectStore('reviewEvents');
    for (const event of fixtures.reviewEvents) events.put(event);
    const pins = tx.objectStore('pins');
    for (const pin of fixtures.pins) pins.put(pin);
    const stats = tx.objectStore('stats');
    for (const record of fixtures.stats) stats.put(record);
    tx.objectStore('meta').put({ key: 'seedVersion', value: DEMO_SEED_VERSION });
  }

  /** Idempotent: a browser that already carries this fixture version is left alone. */
  async function seedIfNeeded() {
    const marker = await getMeta('seedVersion');
    if (Number(marker?.value) >= DEMO_SEED_VERSION) return { seeded: false };
    await putRecords(DEMO_STORE_NAMES, (tx) => writeFixtures(tx, seedFixtures()));
    return { seeded: true };
  }

  /**
   * Clear everything this origin holds for the demo and restore the synthetic
   * fixtures. Clearing and re-seeding share one transaction, so a failed reset
   * aborts as a whole instead of leaving a half-cleared demo behind. Local
   * accounts, their submissions, evidence and reading statistics are gone.
   */
  async function resetAll() {
    await putRecords(DEMO_STORE_NAMES, (tx) => {
      for (const storeName of DEMO_STORE_NAMES) tx.objectStore(storeName).clear();
      writeFixtures(tx, seedFixtures());
    });
  }

  return {
    open,
    name,
    version,
    isAdminEmail: (email) => normalizeEmail(email) === DEMO_ADMIN_EMAIL,
    listAccounts,
    sendCode,
    signIn,
    readSession,
    writeSession,
    listSubmissions,
    getSubmission,
    createSubmission,
    listEvidence,
    reviewSubmission,
    listReviewEvents,
    listAllReviewEvents,
    setPin,
    getStats,
    listStats,
    recordNoteView,
    addActiveTime,
    seedIfNeeded,
    resetAll,
    getMeta,
    setMeta,
  };
}
