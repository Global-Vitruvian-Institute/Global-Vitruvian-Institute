import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVault, loadFrontmatterParser } from '../reader/src/vault.js';
import { createRenderer } from '../reader/src/render.js';

await loadFrontmatterParser();
test('private notes and settings are excluded; wikilinks and backlinks resolve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitruvian-test-'));
  try {
    await writeFile(join(root, 'Home.md'), '# Home\n\n[[Other]] [[Secret]]\n<script>alert(1)</script>');
    await writeFile(join(root, 'Other.md'), '# Other');
    await writeFile(join(root, 'Secret.md'), '---\nprivate: true\n---\nSensitive');
    await mkdir(join(root, '.obsidian'));
    await writeFile(join(root, '.obsidian', 'Hidden.md'), 'settings');
    const vault = await loadVault(root);
    assert.deepEqual([...vault.notes.keys()].sort(), ['Home', 'Other']);
    const html = createRenderer(vault)(vault.notes.get('Home'));
    assert.match(html, /data-note-id="Other"/);
    assert.match(html, /class="note-link missing"/);
    assert.doesNotMatch(html, /<script>/);
    assert.equal(vault.notes.get('Other').backlinks[0].id, 'Home');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('static reader serves note, search, random and missing responses without a backend', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    bootstrap: { defaultNoteId: 'Home' },
    notes: { Home: { id: 'Home', title: 'Home', text: 'welcome' }, Other: { id: 'Other', title: 'Other', text: 'wellness' } },
  }));
  try {
    const { fetchStatic } = await import('../reader/public/static-api.js');
    assert.equal((await (await fetchStatic('/api/note?id=Home')).json()).note.id, 'Home');
    assert.equal((await (await fetchStatic('/api/search?q=wellness')).json()).results[0].id, 'Other');
    assert.equal((await (await fetchStatic('/api/random?not=Home')).json()).id, 'Other');
    assert.equal((await fetchStatic('/api/note?id=Secret')).status, 404);
    assert.equal((await (await fetchStatic('/api/bootstrap')).json()).defaultNoteId, 'Home');
  } finally { globalThis.fetch = originalFetch; }
});

test('shareable stack URLs work on GitHub Pages project paths', async () => {
  const app = await readFile('reader/public/app.js', 'utf8');
  assert.match(app, /return '\.\/\?note='/);
  assert.match(app, /params.getAll\('stackedNotes'\)/);
});
