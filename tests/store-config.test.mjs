import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeStore, INCOMPLETE_CONFIG_MESSAGE } from '../reader/public/store-config.js';

function responseWith(body, { ok = true } = {}) {
  return {
    ok,
    json: async () => body,
  };
}

test('a missing or unreadable config keeps the local demo', async () => {
  const missing = await loadRuntimeStore({
    fetchImpl: async () => responseWith(null, { ok: false }),
  });
  assert.equal(missing.mode, undefined);
  assert.equal(typeof missing.setPin, 'function');

  const offline = await loadRuntimeStore({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(offline.mode, undefined);
  assert.equal(typeof offline.setPin, 'function');
});

test('an explicit local mode keeps the local demo', async () => {
  const store = await loadRuntimeStore({
    fetchImpl: async () => responseWith({ mode: 'local' }),
  });
  assert.equal(store.mode, undefined);
  assert.equal(typeof store.setPin, 'function');
});

test('an incomplete Supabase config yields an unavailable store, not a local fallback', async () => {
  const store = await loadRuntimeStore({
    fetchImpl: async () => responseWith({ mode: 'supabase', url: 'https://example.supabase.co' }),
  });
  assert.equal(store.mode, 'unavailable');
  await assert.rejects(() => store.open(), new RegExp(INCOMPLETE_CONFIG_MESSAGE.slice(0, 24)));
});

test('a complete Supabase config selects the Supabase store', async () => {
  const store = await loadRuntimeStore({
    fetchImpl: async (url) => {
      assert.match(String(url), /supabase-config\.json$/);
      return responseWith({
        mode: 'supabase',
        url: 'https://example.supabase.co',
        publishableKey: 'sb_publishable_test',
      });
    },
  });
  assert.equal(store.mode, 'supabase');
  assert.equal(store.remote, true);
});
