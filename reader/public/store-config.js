/**
 * store-config.js — choose the persistence backend at boot.
 *
 * The shipped site is static, so the choice comes from a small runtime config
 * file next to the reader. The rules are deliberately narrow:
 *
 *  - a missing, unreadable or non-Supabase config keeps the local demo;
 *  - a Supabase config with an incomplete URL/key yields an unavailable store,
 *    which keeps the notes working and explains the failure in the account
 *    region instead of silently falling back to local storage.
 */
import { createDemoStore } from './demo-store.js';
import { createSupabaseStore, createUnavailableStore } from './supabase-store.js';

export const SUPABASE_CONFIG_URL = new URL('./supabase-config.json', import.meta.url);

export const INCOMPLETE_CONFIG_MESSAGE =
  'Supabase is configured for this deployment, but the runtime configuration is incomplete. '
  + 'Account features are unavailable; the notes still work.';

export async function loadRuntimeStore({
  fetchImpl = globalThis.fetch,
  configUrl = SUPABASE_CONFIG_URL,
} = {}) {
  let config = null;
  try {
    const response = await fetchImpl(configUrl, { cache: 'no-store' });
    if (response?.ok) config = await response.json();
  } catch {
    // No runtime config, or it is unreadable: the local demo is the fallback.
    config = null;
  }

  if (!config || config.mode === 'local' || config.mode === 'demo') {
    return createDemoStore();
  }
  if (config.mode !== 'supabase') {
    return createDemoStore();
  }
  if (!config.url || !config.publishableKey) {
    return createUnavailableStore(INCOMPLETE_CONFIG_MESSAGE);
  }
  return createSupabaseStore({ config });
}
