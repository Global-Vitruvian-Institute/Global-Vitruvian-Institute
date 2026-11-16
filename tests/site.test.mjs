import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVault, loadFrontmatterParser } from '../reader/src/vault.js';
import { createRenderer } from '../reader/src/render.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

/* --------------------------------------------------- build: activity flag --- */

test('the build publishes only a boolean activity flag and no raw frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitruvian-vault-'));
  const out = await mkdtemp(join(tmpdir(), 'vitruvian-out-'));
  try {
    await writeFile(join(root, 'Base Note.md'), '# Base Note\n');
    await writeFile(join(root, 'Breath.md'), '---\nactivity: true\n---\n# Breath\n');
    await writeFile(join(root, 'Movement.md'), '---\nactivity: "true"\n---\n# Movement\n');
    await writeFile(join(root, 'Money check-in.md'), '---\nactivity: true\ntitle: Money check-in\n---\n# Money check-in\n');
    await writeFile(join(root, 'Reflection.md'), [
      '---',
      'activity: yes',
      'owner: Ada',
      'authorEmail: ada@example.com',
      'secret-token: hunter2',
      '---',
      '# Reflection',
      '',
    ].join('\n'));
    await writeFile(join(root, 'Plain.md'), '# Plain\n\nNo header at all.\n');
    await writeFile(join(root, 'Secret.md'), '---\nprivate: true\nauthor: Ada\n---\nSensitive\n');
    await writeFile(join(root, 'Tagged.md'), '---\ntags: [private]\n---\nSensitive too\n');

    await run(process.execPath, ['scripts/build.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, VAULT_ROOT: root, OUT_DIR: out },
    });

    const built = JSON.parse(await readFile(join(out, 'notes.json'), 'utf8'));

    // Only the boolean `activity: true` turns logging on.
    assert.equal(built.notes.Breath.activity, true);
    assert.equal(built.notes['Money check-in'].activity, true);
    assert.equal(built.notes.Movement.activity, false, 'the string "true" must not count');
    assert.equal(built.notes.Reflection.activity, false, 'YAML yes must not count');
    assert.equal(built.notes.Plain.activity, false, 'a missing header must not count');
    assert.equal(built.notes['Base Note'].activity, false);

    // Private notes never reach the published index.
    assert.equal(built.notes.Secret, undefined);
    assert.equal(built.notes.Tagged, undefined);

    // The record is a fixed allowlist, so arbitrary frontmatter cannot leak.
    assert.deepEqual(Object.keys(built.notes.Breath).sort(), [
      'activity', 'backlinks', 'html', 'id', 'links', 'obsidianUrl', 'source', 'text', 'title',
    ]);
    const serialized = JSON.stringify(built);
    assert.doesNotMatch(serialized, /hunter2/);
    assert.doesNotMatch(serialized, /ada@example\.com/);
    assert.doesNotMatch(serialized, /frontmatter/);
    assert.equal(built.notes['Money check-in'].title, 'Money check-in');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- reader regression hooks --- */

test('the demo is additive: virtual panes resolve before any note request', async () => {
  const app = await readFile('reader/public/app.js', 'utf8');
  const fillPane = app.slice(app.indexOf('async function fillPane'), app.indexOf('function applyNoteTitle'));
  const fillPreview = app.slice(app.indexOf('async function fillPreview'), app.indexOf('function showPreview'));

  // Demo views are handled inside fillPane, ahead of getNote().
  assert.ok(fillPane.indexOf('demoViewForPaneId(id)') !== -1);
  assert.ok(fillPane.indexOf('demoViewForPaneId(id)') < fillPane.indexOf('await getNote(id)'));
  // The activity control is added once, after a successful render, never in a preview.
  assert.match(fillPane, /demo\?\.decorateArticle\(article, note\)/);
  assert.match(fillPane, /note\.source === 'vault'\) tracker\?\.markRendered\(id\)/);
  assert.doesNotMatch(fillPreview, /decorateArticle|log-activity/);
  assert.doesNotMatch(app, /note\.html[\s\S]{0,80}log-activity/);

  // Reserved ids travel as ordinary pane ids, so Back, Forward, reload and
  // project-subpath URLs keep working without new URL machinery.
  assert.match(app, /isDemoPaneId\(id\) \|\| Boolean\(designUrlFromPaneId\(id\)\)/);
  assert.match(app, /const demoLabel = demoPaneLabel\(id\);/);

  // The demo boots beside the reader and cannot block the notes.
  assert.match(app, /boot\(\);\ninitDemo\(\);/);
  assert.match(app, /demo\.init\(\)\.then\(syncDemoSession\)\.catch\(\(\) => \{\}\);/);

  // A modal dialog owns the keyboard; reader shortcuts stand down.
  assert.match(app, /if \(demo\?\.hasOpenDialog\(\)\) return;/);

  // Rebuilds release the demo's object URLs and clear measured pages.
  assert.match(app, /for \(const pane of state\.panes\) demo\?\.releasePane\(pane\);/);
  assert.match(app, /tracker\?\.clearRendered\(\);/);
});

test('the header exposes exactly one User info entry and a dialog host', async () => {
  const html = await readFile('reader/public/index.html', 'utf8');
  assert.equal((html.match(/<button[^>]*user-info-button/g) ?? []).length, 1);
  assert.match(html, /id="user-info-button"/);
  assert.match(html, />User info<\/button>/);
  assert.match(html, /id="demo-dialog-host"/);
  // No new global navigation item was introduced for the admin view.
  assert.doesNotMatch(html, /id="admin-link"/);
});

test('demo styling is namespaced and reuses the reader tokens', async () => {
  const css = await readFile('reader/public/styles.css', 'utf8');
  assert.match(css, /\.user-info-button \{/);
  assert.match(css, /\.note-content \.demo-row \{/);
  assert.match(css, /\.demo-dialog::backdrop/);
  const demoBlock = css.slice(css.indexOf('demo (local) ---'));
  assert.ok(demoBlock.length > 1000);
  assert.match(demoBlock, /var\(--surface-quiet\)/);
});
