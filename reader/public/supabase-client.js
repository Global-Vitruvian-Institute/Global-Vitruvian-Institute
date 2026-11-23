/**
 * The smallest Supabase client this static reader needs.
 *
 * The site has no bundler and no server, so this module talks to Supabase's
 * REST and Auth endpoints directly. It covers email OTP, session refresh,
 * table reads/writes and private storage uploads with signed downloads.
 * Authorization still belongs in Postgres row-level security; nothing here is
 * trusted by the database.
 */

const DEFAULT_SESSION_KEY = 'vitruvian.supabase.session';

export class SupabaseError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
  }
}

function storageOrNull(scope) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalize(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

export function createSupabaseClient({
  url,
  publishableKey,
  fetchImpl = globalThis.fetch,
  storage = storageOrNull(globalThis),
  sessionKey = DEFAULT_SESSION_KEY,
  now = () => Date.now(),
} = {}) {
  const base = normalize(url);
  const key = String(publishableKey ?? '');
  if (!base || !key) throw new Error('Supabase URL and publishable key are required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  let session = readSession();

  function readSession() {
    try {
      const raw = storage?.getItem(sessionKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeSession(next) {
    session = next;
    try {
      if (!storage) return;
      if (next) storage.setItem(sessionKey, JSON.stringify(next));
      else storage.removeItem(sessionKey);
    } catch {
      /* a browser that refuses storage keeps the in-memory session */
    }
  }

  async function request(path, { method = 'GET', body = undefined, headers = {}, token = null, raw = false } = {}) {
    // The publishable key is an API key, not a JWT. Anonymous requests send only
    // `apikey`; a signed-in request adds the user's access token.
    const authorization = token || session?.access_token || null;
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        apikey: key,
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
        ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });

    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch {
        /* not JSON */
      }
      const message = detail?.msg || detail?.message || detail?.error_description || detail?.error
        || `Supabase request failed (${response.status})`;
      throw new SupabaseError(message, { status: response.status, code: detail?.error_code ?? detail?.code ?? null });
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function saveAuth(payload) {
    if (!payload?.access_token) throw new SupabaseError('Supabase returned no session');
    writeSession({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: now() + Number(payload.expires_in ?? 3600) * 1000,
      user: payload.user ?? session?.user ?? null,
    });
    return session;
  }

  /** Ask Supabase to email a one-time code. No password is involved. */
  async function sendOtp(email) {
    await request('/auth/v1/otp', {
      method: 'POST',
      body: { email: String(email), create_user: true },
    });
    return { sent: true };
  }

  /** Verify the emailed code and keep the resulting session in this browser. */
  async function verifyOtp(email, token) {
    const payload = await request('/auth/v1/verify', {
      method: 'POST',
      body: { type: 'email', email: String(email), token: String(token) },
    });
    return saveAuth(payload);
  }

  let refreshPromise = null;
  let authGeneration = 0;

  function refresh() {
    if (!session?.refresh_token) return Promise.resolve(null);
    if (refreshPromise) return refreshPromise;
    const generation = authGeneration;
    const refreshToken = session.refresh_token;
    refreshPromise = (async () => {
      const payload = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      });
      // Signing out while the refresh was in flight must win.
      if (generation !== authGeneration) return null;
      return saveAuth(payload);
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  /** A usable session, refreshed when it is close to expiry. */
  async function getSession() {
    if (!session) return null;
    if (!session.expires_at || session.expires_at - now() > 60_000) return session;
    return refresh();
  }

  async function signOut() {
    const token = session?.access_token ?? null;
    authGeneration += 1;
    writeSession(null);
    if (!token) return;
    try {
      await request('/auth/v1/logout', { method: 'POST', token });
    } catch {
      /* the local session is already gone */
    }
  }

  async function authHeaders() {
    const live = await getSession();
    return live?.access_token ? { token: live.access_token } : {};
  }

  async function select(table, query = '') {
    const { token } = await authHeaders();
    return request(`/rest/v1/${table}${query ? `?${query}` : ''}`, { token });
  }

  async function insert(table, row) {
    const { token } = await authHeaders();
    return request(`/rest/v1/${table}`, {
      method: 'POST',
      body: row,
      token,
      headers: { prefer: 'return=representation' },
    });
  }

  async function update(table, query, patch) {
    const { token } = await authHeaders();
    return request(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      body: patch,
      token,
      headers: { prefer: 'return=representation' },
    });
  }

  async function remove(table, query) {
    const { token } = await authHeaders();
    return request(`/rest/v1/${table}?${query}`, { method: 'DELETE', token });
  }

  function encodeObjectPath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  /** Upload into the private `evidence` bucket under the owner's folder. */
  async function uploadEvidence(path, file) {
    const { token } = await authHeaders();
    return request(`/storage/v1/object/evidence/${encodeObjectPath(path)}`, {
      method: 'POST',
      body: file,
      raw: true,
      token,
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
    });
  }

  /** A short-lived download URL for one private object. */
  async function signedEvidenceUrl(path, expiresIn = 60) {
    const { token } = await authHeaders();
    const payload = await request(`/storage/v1/object/sign/evidence/${encodeObjectPath(path)}`, {
      method: 'POST',
      body: { expiresIn },
      token,
    });
    const signed = payload?.signedURL ?? payload?.signedUrl;
    if (!signed) throw new SupabaseError('Supabase returned no signed URL');
    return `${base}/storage/v1${signed}`;
  }

  return {
    sendOtp,
    verifyOtp,
    refresh,
    getSession,
    signOut,
    select,
    insert,
    update,
    remove,
    uploadEvidence,
    signedEvidenceUrl,
    get currentSession() {
      return session;
    },
  };
}
