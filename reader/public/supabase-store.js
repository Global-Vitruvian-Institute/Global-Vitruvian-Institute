/**
 * The Supabase-backed store. It exposes the same operations the account views
 * already use for the local demo, so the UI does not need to know which one is
 * running. Ownership and roles are enforced by Postgres RLS, not here.
 */
import {
  DEMO_LIMITS,
  displayNameForEmail,
  normalizeEmail,
  validateEmail,
  validateFeedback,
  validateSubmissionInput,
  validateVerificationCode,
} from './demo-model.js';
import { createSupabaseClient } from './supabase-client.js';

export const REMOTE_DISCLOSURE =
  'Signed in with Supabase. Your reflections and uploaded evidence are visible to you and to reviewers. '
  + 'This is an early preview, not a public portfolio.';

function encode(value) {
  return encodeURIComponent(String(value));
}

function accountFromProfile(profile) {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name || profile.email,
    role: profile.role,
    synthetic: false,
    createdAt: profile.created_at,
  };
}

function submissionFromRow(row) {
  return {
    id: row.id,
    accountId: row.owner,
    noteId: row.note_id,
    noteTitle: row.note_title,
    reflection: row.reflection ?? '',
    status: row.status,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authorEmail: row.profiles?.email ?? null,
    lastFeedback: row.last_feedback ?? null,
    evidence: [],
  };
}

function evidenceMetadataFromRow(row) {
  return {
    id: row.id,
    submissionId: row.submission_id,
    name: row.name,
    type: row.mime,
    size: Number(row.size_bytes),
    objectPath: row.object_path,
  };
}

function pageFromRow(row) {
  return { count: row.visits ?? 1, firstAt: row.first_seen, lastAt: row.last_seen };
}

/** A store whose account features are unavailable, without blocking the notes. */
export function createUnavailableStore(message) {
  const failure = () => {
    throw new Error(message);
  };
  return {
    mode: 'unavailable',
    remote: true,
    disclosure: 'Account features are unavailable in this deployment. The notes still work.',
    account: () => null,
    open: async () => failure(),
    sendCode: async () => failure(),
    signIn: async () => failure(),
    readSession: async () => null,
    writeSession: async () => null,
    listSubmissions: async () => [],
    getSubmission: async () => null,
    listEvidence: async () => [],
    createSubmission: async () => failure(),
    reviewSubmission: async () => failure(),
    listReviewEvents: async () => [],
    listAllReviewEvents: async () => [],
    setPin: async () => failure(),
    getStats: async () => null,
    listStats: async () => [],
    listAccounts: async () => [],
    recordNoteView: async () => null,
    addActiveTime: async () => null,
    seedIfNeeded: async () => ({ seeded: false }),
    resetAll: async () => failure(),
    limits: DEMO_LIMITS,
    displayNameForEmail,
    verifyCodeFormat: validateVerificationCode,
  };
}

export function createSupabaseStore({ config, client = null } = {}) {
  const supabase = client ?? createSupabaseClient({
    url: config.url,
    publishableKey: config.publishableKey,
  });
  let session = null;

  async function profileFor(userId) {
    const rows = await supabase.select('profiles', `select=*&id=eq.${encode(userId)}`);
    return rows?.[0] ?? null;
  }

  async function open() {
    const live = await supabase.getSession();
    if (!live?.user?.id) return { ok: true, error: null };
    const profile = await profileFor(live.user.id);
    session = profile ? accountFromProfile(profile) : null;
    return { ok: true, error: null };
  }

  async function sendCode(email) {
    const problem = validateEmail(email);
    if (problem) throw new Error(problem);
    await supabase.sendOtp(normalizeEmail(email));
    return { sent: true };
  }

  async function signIn(email, code) {
    const problem = validateEmail(email);
    if (problem) throw new Error(problem);
    const normalized = normalizeEmail(email);
    if (!/^\d{6,10}$/.test(String(code ?? '').trim())) {
      throw new Error('Enter the code from the email.');
    }
    await supabase.verifyOtp(normalized, String(code).trim());
    const live = await supabase.getSession();
    const profile = live?.user?.id ? await profileFor(live.user.id) : null;
    if (!profile) {
      throw new Error('Signed in, but this address has no invited profile yet.');
    }
    session = accountFromProfile(profile);
    return { account: session, created: false };
  }

  async function readSession() {
    if (session) return session;
    const live = await supabase.getSession();
    if (!live?.user?.id) return null;
    const profile = await profileFor(live.user.id);
    session = profile ? accountFromProfile(profile) : null;
    return session;
  }

  async function writeSession(value) {
    if (value) return session;
    await supabase.signOut();
    session = null;
    return null;
  }

  /** Attach evidence metadata to submissions so rows show their attachment count. */
  async function hydrateEvidence(submissions) {
    if (!submissions.length) return submissions;
    const rows = await supabase.select(
      'evidence',
      'select=id,submission_id,object_path,name,mime,size_bytes&order=name.asc',
    );
    const bySubmission = new Map();
    for (const row of rows ?? []) {
      const list = bySubmission.get(row.submission_id) ?? [];
      list.push(evidenceMetadataFromRow(row));
      bySubmission.set(row.submission_id, list);
    }
    for (const submission of submissions) {
      submission.evidence = bySubmission.get(submission.id) ?? [];
    }
    return submissions;
  }

  async function listSubmissions({ accountId } = {}) {
    const filter = accountId ? `&owner=eq.${encode(accountId)}` : '';
    const rows = await supabase.select(
      'submissions',
      `select=*,profiles!submissions_owner_fkey(email)&order=pinned.desc,created_at.desc${filter}`,
    );
    return hydrateEvidence((rows ?? []).map(submissionFromRow));
  }

  async function getSubmission(submissionId) {
    const rows = await supabase.select(
      'submissions',
      `select=*,profiles!submissions_owner_fkey(email)&id=eq.${encode(submissionId)}`,
    );
    const [submission] = (rows ?? []).map(submissionFromRow);
    if (!submission) return null;
    await hydrateEvidence([submission]);
    return submission;
  }

  async function listEvidence(submissionId) {
    const rows = await supabase.select(
      'evidence',
      `select=*&submission_id=eq.${encode(submissionId)}&order=name.asc`,
    );
    const records = [];
    for (const row of rows ?? []) {
      const url = await supabase.signedEvidenceUrl(row.object_path, 60);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Evidence "${row.name}" could not be downloaded.`);
      records.push({
        id: row.id,
        submissionId: row.submission_id,
        name: row.name,
        type: row.mime,
        size: Number(row.size_bytes),
        bytes: await response.arrayBuffer(),
      });
    }
    return records;
  }

  async function createSubmission({ accountId, noteId, noteTitle, reflection = '', evidence = [] }) {
    if (!session) throw new Error('Sign in before logging an activity.');
    const checked = validateSubmissionInput({
      reflection,
      files: evidence.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    });
    if (!checked.ok) throw new Error(checked.errors.summary || 'That submission could not be saved.');

    const inserted = await supabase.insert('submissions', {
      owner: accountId,
      note_id: noteId,
      note_title: noteTitle,
      reflection: checked.reflection,
      status: 'pending',
    });
    const submission = inserted?.[0];
    if (!submission) throw new Error('The submission was not saved.');

    const attempted = [];
    try {
      for (const file of evidence) {
        const safeName = String(file.name).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'evidence';
        const objectPath = `${accountId}/${submission.id}/${crypto.randomUUID()}-${safeName}`;
        // Record the path before the upload: an upload that fails ambiguously
        // may still have written the object, so it must be cleaned up too.
        attempted.push(objectPath);
        await supabase.uploadEvidence(objectPath, new Blob([file.bytes], { type: file.type || 'application/octet-stream' }));
        await supabase.insert('evidence', {
          submission_id: submission.id,
          object_path: objectPath,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size_bytes: file.bytes.byteLength,
        });
      }
    } catch (error) {
      // Objects first: the storage policy only allows deleting evidence that
      // still belongs to a pending submission, so the row has to outlive them.
      const leftover = [];
      for (const path of attempted) {
        try {
          await supabase.removeEvidence(path);
        } catch (cleanupError) {
          if (cleanupError?.status !== 404) leftover.push(path);
        }
      }
      try {
        await supabase.remove('submissions', `id=eq.${encode(submission.id)}`);
      } catch {
        leftover.push(submission.id);
      }
      if (leftover.length) {
        // Do not swallow failed cleanup: say what may still be stored.
        throw new Error(
          `${error?.message ?? 'That submission could not be saved.'} `
          + `Cleanup also failed for: ${leftover.join(', ')}.`,
          { cause: error },
        );
      }
      throw error;
    }

    return { submission: submissionFromRow(submission), evidence: [] };
  }

  async function reviewSubmission({ submissionId, status, feedback = '', reviewerEmail }) {
    const problem = validateFeedback(feedback, { required: status === 'changes_requested' });
    if (problem) throw new Error(problem);
    // One transactional RPC: staff check, row lock, status update and review
    // insert all happen together, so a failure cannot half-apply a review.
    const payload = await supabase.rpc('review_submission', {
      p_submission_id: submissionId,
      p_status: status,
      p_feedback: feedback,
    });
    // A single-row composite RPC comes back as an object; tolerate an array.
    const reviewed = Array.isArray(payload) ? payload[0] : payload;
    if (!reviewed?.id) throw new Error('That submission could not be reviewed.');
    return { submission: submissionFromRow(reviewed), event: null };
  }

  function reviewEventFromRow(row) {
    return {
      id: row.id,
      submissionId: row.submission_id,
      status: row.decision,
      feedback: row.feedback,
      at: row.created_at,
      reviewerEmail: row.reviewer_email ?? null,
    };
  }

  async function listReviewEvents(submissionId) {
    const rows = await supabase.rpc('review_history', { p_submission_id: submissionId });
    return (rows ?? []).map(reviewEventFromRow);
  }

  /** Staff see every review; a participant's history comes from listReviewEvents. */
  async function listAllReviewEvents() {
    const rows = await supabase.rpc('review_history', { p_submission_id: null });
    return (rows ?? []).map(reviewEventFromRow);
  }

  async function setPin(accountId, submissionId, pinned) {
    const value = Boolean(pinned);
    // Pinning must work at every review status, so it uses a narrow RPC that
    // checks ownership and touches only `pinned`.
    await supabase.rpc('set_submission_pin', { p_submission_id: submissionId, p_pinned: value });
    return value;
  }

  async function getStats(accountId) {
    const [pagesRows, totalRows] = await Promise.all([
      supabase.select('reading_stats', `select=*&owner=eq.${encode(accountId)}`),
      supabase.select('account_stats', `select=*&owner=eq.${encode(accountId)}`),
    ]);
    const pages = {};
    for (const row of pagesRows ?? []) {
      pages[row.note_id] = pageFromRow(row);
    }
    return {
      accountId,
      pages,
      activeMs: Number(totalRows?.[0]?.active_ms ?? 0),
      updatedAt: totalRows?.[0]?.updated_at ?? null,
      synthetic: false,
    };
  }

  async function listStats() {
    const [profiles, pagesRows, totals] = await Promise.all([
      supabase.select('profiles', 'select=*'),
      supabase.select('reading_stats', 'select=*'),
      supabase.select('account_stats', 'select=*'),
    ]);
    return (profiles ?? []).map((profile) => {
      const pages = {};
      for (const row of pagesRows ?? []) {
        if (row.owner !== profile.id) continue;
        pages[row.note_id] = pageFromRow(row);
      }
      const total = (totals ?? []).find((row) => row.owner === profile.id);
      return {
        accountId: profile.id,
        pages,
        activeMs: Number(total?.active_ms ?? 0),
        updatedAt: total?.updated_at ?? null,
        synthetic: false,
      };
    });
  }

  async function listAccounts() {
    const rows = await supabase.select('profiles', 'select=*&order=created_at.asc');
    return (rows ?? []).map(accountFromProfile);
  }

  async function recordNoteView(accountId, noteId) {
    if (!session) return null;
    return supabase.rpc('record_note_view', { p_note_id: noteId });
  }

  async function addActiveTime(accountId, ms) {
    if (!session) return null;
    return supabase.rpc('add_active_time', { p_ms: Math.max(0, Math.round(ms)) });
  }

  async function seedIfNeeded() {
    return { seeded: false };
  }

  async function resetAll() {
    throw new Error('Accounts and evidence are managed by Supabase; clearing this browser does not delete them.');
  }

  return {
    mode: 'supabase',
    remote: true,
    disclosure: REMOTE_DISCLOSURE,
    account: () => (session ? { ...session } : null),
    open,
    sendCode,
    signIn,
    readSession,
    writeSession,
    listSubmissions,
    getSubmission,
    listEvidence,
    createSubmission,
    reviewSubmission,
    listReviewEvents,
    listAllReviewEvents,
    setPin,
    getStats,
    listStats,
    listAccounts,
    recordNoteView,
    addActiveTime,
    seedIfNeeded,
    resetAll,
    limits: DEMO_LIMITS,
    displayNameForEmail,
    verifyCodeFormat: validateVerificationCode,
  };
}
