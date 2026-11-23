import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore, createUnavailableStore } from '../reader/public/supabase-store.js';

const PROFILE = { id: 'u1', email: 'a@example.com', display_name: 'A', role: 'participant', created_at: 'x' };

function fakeClient(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve([]);
  };
  return {
    calls,
    select: async (table, query) => {
      calls.push({ name: 'select', table, query });
      return overrides.select?.(table, query) ?? [];
    },
    insert: async (table, row) => {
      calls.push({ name: 'insert', table, row });
      if (overrides.insert) return overrides.insert(table, row);
      return [{ id: 's1', ...row, created_at: '2026-01-01', updated_at: '2026-01-01' }];
    },
    update: async (table, query, patch) => {
      calls.push({ name: 'update', table, query, patch });
      return overrides.update?.(table, query, patch) ?? [{ id: 's1' }];
    },
    remove: async (table, query) => {
      calls.push({ name: 'remove', table, query });
      return overrides.remove?.(table, query);
    },
    removeEvidence: async (path) => {
      calls.push({ name: 'removeEvidence', path });
      return overrides.removeEvidence?.(path);
    },
    sendOtp: record('sendOtp'),
    verifyOtp: async () => ({ access_token: 'a' }),
    getSession: async () => overrides.session?.() ?? null,
    signOut: record('signOut'),
    signedEvidenceUrl: async () => 'https://example.test/file',
    uploadEvidence: async (path, blob) => {
      calls.push({ name: 'uploadEvidence', path });
      return overrides.uploadEvidence?.(path, blob);
    },
    rpc: async (fn, args) => {
      calls.push({ name: 'rpc', fn, args });
      return overrides.rpc?.(fn, args) ?? null;
    },
  };
}

function storeWith(client) {
  return createSupabaseStore({ config: { url: 'https://x', publishableKey: 'k' }, client });
}

const SUBMISSION_ROW = {
  id: 's1',
  owner: 'u1',
  note_id: 'Breath',
  note_title: 'Breath',
  reflection: 'r',
  status: 'pending',
  pinned: true,
  last_feedback: 'Needs more detail',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  profiles: { email: 'a@example.com' },
};

const EVIDENCE_ROW = {
  id: 'e1',
  submission_id: 's1',
  object_path: 'u1/s1/a.png',
  name: 'a.png',
  mime: 'image/png',
  size_bytes: 10,
};

test('sign-in uses OTP and returns the invited profile with its role', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [{ ...PROFILE, role: 'admin' }] : []),
  });
  const store = storeWith(client);
  await store.open();
  const { account } = await store.signIn('a@example.com', '123456');
  assert.equal(account.role, 'admin');
  assert.equal(account.email, 'a@example.com');
  assert.equal(client.calls.filter((call) => call.name === 'sendOtp').length, 0);
});

test('a malformed code is rejected before any network call', async () => {
  const client = fakeClient();
  const store = storeWith(client);
  await assert.rejects(() => store.signIn('a@example.com', 'nope'), /code from the email/);
  assert.equal(client.calls.some((call) => call.name === 'verifyOtp'), false);
});

test('submissions hydrate evidence metadata and keep the latest feedback', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles'
      ? [PROFILE]
      : table === 'submissions'
        ? [SUBMISSION_ROW]
        : table === 'evidence'
          ? [EVIDENCE_ROW]
          : []),
  });
  const store = storeWith(client);
  await store.open();
  const [row] = await store.listSubmissions({ accountId: 'u1' });
  assert.equal(row.noteTitle, 'Breath');
  assert.equal(row.authorEmail, 'a@example.com');
  assert.equal(row.pinned, true);
  assert.equal(row.lastFeedback, 'Needs more detail');
  assert.deepEqual(row.evidence, [{
    id: 'e1', submissionId: 's1', name: 'a.png', type: 'image/png', size: 10, objectPath: 'u1/s1/a.png',
  }]);
});

test('getSubmission returns a hydrated submission or null', async () => {
  const client = fakeClient({
    select: (table) => (table === 'submissions'
      ? [SUBMISSION_ROW]
      : table === 'evidence'
        ? [EVIDENCE_ROW]
        : []),
  });
  const store = storeWith(client);
  const submission = await store.getSubmission('s1');
  assert.equal(submission.id, 's1');
  assert.equal(submission.evidence.length, 1);

  const empty = fakeClient();
  assert.equal(await storeWith(empty).getSubmission('missing'), null);
});

test('pinning goes through the narrow ownership-checked RPC', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [PROFILE] : []),
    rpc: (fn) => (fn === 'set_submission_pin' ? true : null),
  });
  const store = storeWith(client);
  await store.open();
  const result = await store.setPin('u1', 's1', false);
  assert.equal(result, false);
  const pin = client.calls.find((call) => call.name === 'rpc' && call.fn === 'set_submission_pin');
  assert.deepEqual(pin.args, { p_submission_id: 's1', p_pinned: false });
  // No direct table update: the participant update policy would reject a reviewed row.
  assert.equal(client.calls.some((call) => call.name === 'update'), false);
});

test('a review is one transactional RPC, never a status PATCH plus insert', async () => {
  const reviewed = { ...SUBMISSION_ROW, status: 'verified', last_feedback: null };
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    rpc: (fn) => (fn === 'review_submission' ? reviewed : null),
  });
  const store = storeWith(client);
  const { submission } = await store.reviewSubmission({
    submissionId: 's1', status: 'verified', feedback: 'Looks good',
  });
  assert.equal(submission.status, 'verified');
  const calls = client.calls.filter((call) => call.name === 'rpc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'review_submission');
  assert.deepEqual(calls[0].args, { p_submission_id: 's1', p_status: 'verified', p_feedback: 'Looks good' });
  assert.equal(client.calls.some((call) => call.name === 'update'), false);
  assert.equal(client.calls.some((call) => call.name === 'insert'), false);
});

test('requesting changes without feedback is rejected before any request', async () => {
  const client = fakeClient();
  const store = storeWith(client);
  await assert.rejects(
    () => store.reviewSubmission({ submissionId: 's1', status: 'changes_requested', feedback: '  ' }),
    /feedback/i,
  );
  assert.equal(client.calls.some((call) => call.name === 'rpc'), false);
});

test('review history carries the reviewer identity from the authorized RPC', async () => {
  const rows = [{
    id: 'r1',
    submission_id: 's1',
    decision: 'changes_requested',
    feedback: 'Add detail',
    created_at: '2026-01-02',
    reviewer_email: 'reviewer@example.com',
    reviewer_name: 'Reviewer',
  }];
  const client = fakeClient({ rpc: (fn) => (fn === 'review_history' ? rows : null) });
  const store = storeWith(client);
  const [event] = await store.listReviewEvents('s1');
  assert.equal(event.reviewerEmail, 'reviewer@example.com');
  assert.equal(event.status, 'changes_requested');
  const call = client.calls.find((entry) => entry.name === 'rpc');
  assert.deepEqual(call.args, { p_submission_id: 's1' });
});

test('statistics normalize page timestamps to the local model shape', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => {
      if (table === 'profiles') return [PROFILE];
      if (table === 'reading_stats') {
        return [{ owner: 'u1', note_id: 'Breath', visits: 2, first_seen: 'a', last_seen: 'b' }];
      }
      if (table === 'account_stats') return [{ owner: 'u1', active_ms: 5000, updated_at: 'c' }];
      return [];
    },
  });
  const store = storeWith(client);
  await store.open();
  const stats = await store.getStats('u1');
  assert.deepEqual(stats.pages.Breath, { count: 2, firstAt: 'a', lastAt: 'b' });
  assert.equal(stats.activeMs, 5000);
});

test('remote statistics use the two RPCs and refuse local reset', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [PROFILE] : []),
  });
  const store = storeWith(client);
  await store.open();
  await store.recordNoteView('u1', 'Breath');
  await store.addActiveTime('u1', 4200);
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'rpc').map((call) => call.fn),
    ['record_note_view', 'add_active_time'],
  );
  await assert.rejects(() => store.resetAll(), /managed by Supabase/);
  assert.equal(client.calls.some((call) => call.name === 'signOut'), false);
});

test('a failed metadata insert removes the object before the pending submission', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [PROFILE] : []),
    insert: (table) => {
      if (table === 'evidence') throw new Error('metadata failed');
      return [{ id: 's1', owner: 'u1', note_id: 'Breath', note_title: 'Breath', reflection: '', status: 'pending', pinned: false, created_at: 'x', updated_at: 'x' }];
    },
  });
  const store = storeWith(client);
  await store.open();
  await assert.rejects(() => store.createSubmission({
    accountId: 'u1',
    noteId: 'Breath',
    noteTitle: 'Breath',
    reflection: 'r',
    evidence: [{ name: 'a.png', type: 'image/png', size: 3, bytes: new Uint8Array([1, 2, 3]) }],
  }), /metadata failed/);

  const cleanup = client.calls.filter((call) => call.name === 'removeEvidence' || call.name === 'remove');
  assert.deepEqual(cleanup.map((call) => call.name), ['removeEvidence', 'remove']);
  assert.match(cleanup[0].path, /^u1\/s1\//);
  assert.match(cleanup[1].query, /id=eq\.s1/);
});

test('failed cleanup is reported instead of swallowed', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [PROFILE] : []),
    insert: (table) => {
      if (table === 'evidence') throw new Error('metadata failed');
      return [{ id: 's1', owner: 'u1', note_id: 'Breath', note_title: 'Breath', reflection: '', status: 'pending', pinned: false, created_at: 'x', updated_at: 'x' }];
    },
    removeEvidence: () => {
      throw Object.assign(new Error('storage down'), { status: 500 });
    },
  });
  const store = storeWith(client);
  await store.open();
  await assert.rejects(() => store.createSubmission({
    accountId: 'u1',
    noteId: 'Breath',
    noteTitle: 'Breath',
    reflection: 'r',
    evidence: [{ name: 'a.png', type: 'image/png', size: 3, bytes: new Uint8Array([1, 2, 3]) }],
  }), /Cleanup also failed for/);
});

test('a missing object is not reported as failed cleanup', async () => {
  const client = fakeClient({
    session: () => ({ user: { id: 'u1' } }),
    select: (table) => (table === 'profiles' ? [PROFILE] : []),
    insert: (table) => {
      if (table === 'evidence') throw new Error('metadata failed');
      return [{ id: 's1', owner: 'u1', note_id: 'Breath', note_title: 'Breath', reflection: '', status: 'pending', pinned: false, created_at: 'x', updated_at: 'x' }];
    },
    removeEvidence: () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    },
  });
  const store = storeWith(client);
  await store.open();
  await assert.rejects(() => store.createSubmission({
    accountId: 'u1',
    noteId: 'Breath',
    noteTitle: 'Breath',
    reflection: 'r',
    evidence: [{ name: 'a.png', type: 'image/png', size: 3, bytes: new Uint8Array([1, 2, 3]) }],
  }), (error) => !/Cleanup also failed/.test(error.message));
});

test('an incomplete Supabase configuration reports an unavailable store', async () => {
  const store = createUnavailableStore('configuration is incomplete');
  assert.equal(store.mode, 'unavailable');
  await assert.rejects(() => store.open(), /configuration is incomplete/);
});
