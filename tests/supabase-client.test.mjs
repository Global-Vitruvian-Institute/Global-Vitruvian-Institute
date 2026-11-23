import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClient, SupabaseError } from '../reader/public/supabase-client.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (!(path in routes)) throw new Error(`unexpected request: ${path}`);
    const route = routes[path];
    const payload = typeof route === 'function' ? route(options) : route;
    if (payload instanceof Error) throw payload;
    if (payload?.deferred) return payload.deferred;
    const status = payload?.status ?? 200;
    const body = payload?.body ?? payload ?? null;
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

test('email OTP stores a session and refreshes it when expired', async () => {
  const storage = memoryStorage();
  let clock = 1_000;
  const fetchImpl = fakeFetch({
    '/auth/v1/otp': { body: {} },
    '/auth/v1/verify': {
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        user: { id: 'user-1' },
      },
    },
    '/auth/v1/token': {
      body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, user: { id: 'user-1' } },
    },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co/',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
    now: () => clock,
  });

  assert.deepEqual(await client.sendOtp('a@example.com'), { sent: true });
  assert.equal(fetchImpl.calls[0].url, 'https://example.supabase.co/auth/v1/otp');
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).email, 'a@example.com');
  // The publishable key is not a bearer token.
  assert.equal(fetchImpl.calls[0].options.headers.authorization, undefined);
  assert.equal(fetchImpl.calls[0].options.headers.apikey, 'sb_publishable_test');

  const session = await client.verifyOtp('a@example.com', '123456');
  assert.equal(session.access_token, 'access-1');
  assert.equal(storage.getItem('vitruvian.supabase.session').includes('refresh-1'), true);

  clock += 3_600_000;
  const refreshed = await client.getSession();
  assert.equal(refreshed.access_token, 'access-2');
  assert.equal(JSON.parse(fetchImpl.calls.at(-1).options.body).refresh_token, 'refresh-1');
  assert.equal(client.currentSession.access_token, 'access-2');
});

test('REST requests carry the publishable key and the session token', async () => {
  const storage = memoryStorage();
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': { body: { access_token: 'access-1', refresh_token: 'r', expires_in: 3600, user: { id: 'u' } } },
    '/rest/v1/submissions': { body: [{ id: 's1' }] },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
  });
  await client.verifyOtp('a@example.com', '123456');
  const rows = await client.select('submissions', 'select=*');
  assert.deepEqual(rows, [{ id: 's1' }]);
  const call = fetchImpl.calls.at(-1);
  assert.equal(call.url, 'https://example.supabase.co/rest/v1/submissions?select=*');
  assert.equal(call.options.headers.apikey, 'sb_publishable_test');
  assert.equal(call.options.headers.authorization, 'Bearer access-1');
});

test('HTTP errors surface status and message; sign-out clears the local session', async () => {
  const storage = memoryStorage();
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': { status: 403, body: { msg: 'Token has expired or is invalid', error_code: 'otp_expired' } },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
  });
  await assert.rejects(
    () => client.verifyOtp('a@example.com', '000000'),
    (error) => error instanceof SupabaseError && error.status === 403 && error.code === 'otp_expired',
  );

  // Establish a session, then sign out.
  const second = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl: fakeFetch({
      '/auth/v1/verify': { body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u' } } },
      '/auth/v1/logout': { status: 204, body: null },
    }),
    storage,
  });
  await second.verifyOtp('a@example.com', '123456');
  await second.signOut();
  assert.equal(second.currentSession, null);
  assert.equal(storage.getItem('vitruvian.supabase.session'), null);
});

test('private evidence uploads use the owner token and signed URLs', async () => {
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': { body: { access_token: 'access-1', refresh_token: 'r', expires_in: 3600, user: { id: 'u' } } },
    '/storage/v1/object/evidence/u/s1/proof.png': { body: {} },
    '/storage/v1/object/sign/evidence/u/s1/proof.png': { body: { signedURL: '/object/sign/evidence/u/s1/proof.png?token=t' } },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage: memoryStorage(),
  });
  await client.verifyOtp('a@example.com', '123456');
  await client.uploadEvidence('u/s1/proof.png', new Blob(['x'], { type: 'image/png' }));
  const upload = fetchImpl.calls.at(-1);
  assert.equal(upload.options.headers['content-type'], 'image/png');
  assert.equal(upload.options.headers.authorization, 'Bearer access-1');

  const url = await client.signedEvidenceUrl('u/s1/proof.png');
  assert.equal(url, 'https://example.supabase.co/storage/v1/object/sign/evidence/u/s1/proof.png?token=t');
});

test('a rejected refresh token clears the stored session', async () => {
  const storage = memoryStorage();
  let clock = 1_000;
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': {
      body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'u' } },
    },
    '/auth/v1/token': { status: 400, body: { error: 'invalid_grant', error_code: 'refresh_token_not_found' } },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
    now: () => clock,
  });
  await client.verifyOtp('a@example.com', '123456');
  clock += 3_600_000;

  assert.equal(await client.getSession(), null);
  assert.equal(client.currentSession, null);
  assert.equal(storage.getItem('vitruvian.supabase.session'), null);
});

test('an unreachable refresh keeps a valid session for a later retry', async () => {
  const storage = memoryStorage();
  let clock = 1_000;
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': {
      body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'u' } },
    },
    '/auth/v1/token': { status: 503, body: { message: 'upstream unavailable' } },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
    now: () => clock,
  });
  await client.verifyOtp('a@example.com', '123456');
  clock += 3_600_000;

  await assert.rejects(() => client.getSession(), /upstream unavailable/);
  assert.notEqual(client.currentSession, null);
  assert.notEqual(storage.getItem('vitruvian.supabase.session'), null);
});

test('a bare 401 is treated as a service problem, not a dead session', async () => {
  const storage = memoryStorage();
  let clock = 1_000;
  const fetchImpl = fakeFetch({
    '/auth/v1/verify': {
      body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'u' } },
    },
    '/auth/v1/token': { status: 401, body: { message: 'Invalid API key' } },
  });
  const client = createSupabaseClient({
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl,
    storage,
    now: () => clock,
  });
  await client.verifyOtp('a@example.com', '123456');
  clock += 3_600_000;

  await assert.rejects(() => client.getSession(), /Invalid API key/);
  assert.notEqual(client.currentSession, null);
  assert.notEqual(storage.getItem('vitruvian.supabase.session'), null);
});
