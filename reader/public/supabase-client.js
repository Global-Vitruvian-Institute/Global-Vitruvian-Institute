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

/**
 * A refresh failure that will never succeed with the same token. Network and
 * server errors are not in this set: an unreachable Supabase must not cost the
 * reader their stored session.
 */
function isInvalidSessionError(error) {
  if (!(error instanceof SupabaseError)) return false;
  const code = String(error.code ?? '').toLowerCase();
  if (code) {
    return (error.status === 400 || error.status === 401)
      && (code.includes('refresh_token')
        || code.includes('invalid_grant')
        || code.includes('session')
        || code.includes('invalid_claims')
        || code.includes('user_not_found'));
  }
  // GoTrue answers a dead refresh token with 400 even when it omits an error
  // code. A bare 401 is more likely a bad publishable key than a dead session,
  // so it is not treated as definitive.
  return error.status === 400;
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

  /**
   * Supabase's default magic-link email returns to this site with the session in
   * the URL fragment. Capture it once, then remove it from the address bar.
   */
  function captureSessionFromUrl() {
    try {
      const location = globalThis.location;
      if (!location?.hash) return null;
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (!accessToken || !refreshToken) return null;
      writeSession({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: now() + Number(params.get('expires_in') ?? 3600) * 1000,
        user: null,
      });
      const clean = `${location.pathname}${location.search}`;
      globalThis.history?.replaceState?.(null, '', clean);
      return session;
    } catch {
      return null;
    }
  }

  captureSessionFromUrl();

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
    // Return the link to whichever page asked for it, provided that origin is
    // on the project's Redirect URLs allowlist.
    let redirectTo = null;
    try {
      const location = globalThis.location;
      if (location?.origin && location?.pathname) redirectTo = `${location.origin}${location.pathname}`;
    } catch {
      /* no browser location */
    }
    const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    await request(`/auth/v1/otp${query}`, {
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
      let payload;
      try {
        payload = await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: refreshToken },
        });
      } catch (error) {
        // A rejected refresh token can never be retried. Drop it so the account
        // UI returns to signed-out instead of stranding the reader on an error.
        if (isInvalidSessionError(error)) {
          if (generation === authGeneration) {
            authGeneration += 1;
            writeSession(null);
          }
          return null;
        }
        throw error;
      }
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

  async function rpc(fn, args = {}) {
    const { token } = await authHeaders();
    return request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, token });
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

  async function removeEvidence(path) {
    const { token } = await authHeaders();
    return request(`/storage/v1/object/evidence/${encodeObjectPath(path)}`, { method: 'DELETE', token });
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
    rpc,
    uploadEvidence,
    removeEvidence,
    signedEvidenceUrl,
    get currentSession() {
      return session;
    },
  };
}
