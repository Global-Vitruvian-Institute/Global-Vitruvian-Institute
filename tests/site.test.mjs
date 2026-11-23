import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  const route = await readFile('reader/public/view-route.js', 'utf8');
  // The reader still writes a relative `?note=` href, and the stack is still read
  // from repeated `stackedNotes` parameters — now in the pure route module.
  assert.match(app, /return '\.\/\?note='/);
  assert.match(route, /params\.getAll\(STACK_PARAM\)/);
  assert.match(route, /params\.append\(STACK_PARAM, id\)/);
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

    // The published identity is the institute name, not the repository name.
    assert.equal(built.bootstrap.app.title, 'Vitruvian Institute');
    assert.equal(built.bootstrap.vault.name, 'Vitruvian Institute');
    const shell = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(shell, /<title>Vitruvian Institute<\/title>/);
    assert.match(shell, /href="\.\/styles\.css"/);
    assert.match(shell, /src="\.\/app\.js"/);
    assert.match(shell, /href="\.\/"/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------- identity and light --- */

test('the published identity is Vitruvian Institute and the shell is light', async () => {
  const html = await readFile('reader/public/index.html', 'utf8');
  assert.match(html, /<title>Vitruvian Institute<\/title>/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, />Vitruvian Institute<\/a>/);
  assert.doesNotMatch(html, /stacked-notes/);

  const css = await readFile('reader/public/styles.css', 'utf8');
  assert.match(css, /color-scheme:\s*light;/);
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
  // Reading text is the system sans stack, not a serif.
  assert.match(css, /--font-reading:\s*var\(--font-ui\)/);

  const app = await readFile('reader/public/app.js', 'utf8');
  assert.match(app, /return state\.bootstrap\?\.app\?\.title \|\| 'Vitruvian Institute';/);

  const build = await readFile('scripts/build.mjs', 'utf8');
  assert.match(build, /const title = 'Vitruvian Institute';/);
});

test('the shell applies the saved appearance before first paint, in step with appearance.js', async () => {
  const html = await readFile('reader/public/index.html', 'utf8');
  const appearance = await readFile('reader/public/appearance.js', 'utf8');

  const key = appearance.match(/APPEARANCE_KEY = '([^']+)'/)?.[1];
  assert.ok(key, 'appearance.js must declare the storage key');
  assert.match(html, new RegExp(`localStorage\\.getItem\\('${key}'\\)`));

  const ids = [...appearance.matchAll(/^ {4}id: '([a-z-]+)',$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, ['clear', 'paper', 'lilac', 'minimal', 'things', 'blue-topaz', 'dark', 'khan', 'editorial']);
  for (const id of ids) {
    assert.match(html, new RegExp(`'${id}'`), `the shell must accept the ${id} template`);
    assert.ok(existsSync(`reader/public/themes/${id}.css`), `themes/${id}.css must exist`);
  }
  // The inline script must run before the stylesheet, so nothing flashes.
  assert.ok(html.indexOf('vitruvian.appearance') < html.indexOf('rel="stylesheet"'));
});

/* ------------------------------------------------- reader regression hooks --- */

test('account views are a separate page region, not panes in the stack', async () => {
  const app = await readFile('reader/public/app.js', 'utf8');
  const html = await readFile('reader/public/index.html', 'utf8');
  const route = await readFile('reader/public/view-route.js', 'utf8');
  const ui = await readFile('reader/public/demo-ui.js', 'utf8');

  // The reading stack and the account region are siblings, and only one of them
  // is ever exposed.
  assert.match(html, /<main class="stack" id="stack"/);
  assert.match(html, /<main class="account" id="account" hidden/);
  assert.match(app, /function showRegion\(view\)/);
  assert.match(app, /els\.stack\.hidden = account;/);
  assert.match(app, /els\.account\.hidden = !account;/);

  // The reserved pane ids are still read out of old URLs and migrated, but they
  // can never be opened as a reader pane again.
  assert.match(app, /if \(isDemoPaneId\(id\)\) return false;/);
  assert.match(app, /const parsed = parseViewRoute\(window\.location\.search, window\.location\.hash\);/);
  assert.match(route, /'demo:account': VIEW_ACCOUNT/);
  assert.match(route, /'demo:admin': VIEW_ADMIN/);
  assert.doesNotMatch(app, /DEMO_PANE_ACCOUNT|DEMO_PANE_ADMIN/);
  assert.doesNotMatch(ui, /demo:admin/);

  // The account region renders through the demo's guarded per-host render.
  assert.match(app, /await demo\.renderPane\(els\.accountContent, view, \{/);
  assert.match(ui, /async function renderPane\(host, view, \{ isCurrent = \(\) => true \} = \{\}\) \{/);

  // Boot, Back/Forward and normalisation all reconcile the same way.
  assert.match(app, /function reconcileRoute\(\)/);
  assert.match(app, /window\.addEventListener\('popstate', onPopState\);/);
  assert.match(app, /function onPopState\(\) \{[\s\S]{0,200}reconcileRoute\(\);/);

  // A hidden reader is never measured, and a closed dialog cannot resume it.
  assert.match(app, /tracker\?\.setPaused\(Boolean\(demo\?\.hasOpenDialog\(\)\) \|\| isAccountView\(state\.view\)\);/);
  assert.match(app, /if \(isAccountView\(state\.view\)\) \{\n\s*tracker\?\.setActiveNote\(null\);/);

  // Admin navigation uses the same role predicate as the account views: the
  // demo-email shortcut is local-only.
  assert.match(app, /els\.accountAdmin\.hidden = !\(demo\?\.session && demo\?\.canReview\(demo\.session\)\);/);
  assert.match(ui, /!remote && isAdminEmail\(account\.email\)/);

  // The saved preference is applied before the chrome renders, and the runtime
  // store is chosen before the reader boots.
  assert.match(app, /initAppearance\(\);\ninitReadingMode\(\);\ndemoBoot = initDemo\(\);\nboot\(\);/);
});

test('the demo is additive: it decorates rendered notes and cannot block them', async () => {
  const app = await readFile('reader/public/app.js', 'utf8');
  const fillPane = app.slice(app.indexOf('async function fillPane'), app.indexOf('function applyNoteTitle'));
  const fillPreview = app.slice(app.indexOf('async function fillPreview'), app.indexOf('function showPreview'));

  // The activity control is added once, after a successful render, never in a preview.
  assert.match(fillPane, /demo\.decorateArticle\(article, note\)/);
  assert.match(fillPane, /if \(note\.source === 'vault'\) \{/);
  assert.match(fillPane, /tracker\.markRendered\(id\)/);
  assert.doesNotMatch(fillPane, /demoViewForPaneId|demo\.renderPane/);
  assert.doesNotMatch(fillPreview, /decorateArticle|log-activity/);
  assert.doesNotMatch(app, /note\.html[\s\S]{0,80}log-activity/);

  // The demo boots beside the reader and cannot block the notes. A note that
  // rendered before the runtime store was chosen is decorated and counted later.
  assert.match(app, /import \{ loadRuntimeStore \} from '\.\/store-config\.js';/);
  assert.match(app, /demoStore = await loadRuntimeStore\(\);/);
  assert.match(app, /const pendingDemoDecorations = new Map\(\);/);
  assert.match(app, /for \(const \[article, entry\] of pendingDemoDecorations\)/);
  assert.match(app, /demo\.init\(\)\.then\(syncDemoSession\)\.catch\(\(\) => \{\}\);/);

  // A modal dialog owns the keyboard; reader shortcuts stand down.
  assert.match(app, /if \(demo\?\.hasOpenDialog\(\)\) return;/);

  // Rebuilds release the demo's object URLs and clear measured pages.
  assert.match(app, /for \(const pane of state\.panes\) demo\?\.releasePane\(pane\);/);
  assert.match(app, /tracker\?\.clearRendered\(\);/);
  // Returning to the notes revokes the account region's evidence URLs.
  assert.match(app, /demo\?\.releasePane\(els\.accountContent\);/);
});

test('the header exposes exactly one account entry, a dialog host and one account region', async () => {
  const html = await readFile('reader/public/index.html', 'utf8');
  assert.equal((html.match(/<button[^>]*user-info-button/g) ?? []).length, 1);
  assert.match(html, /id="user-info-button"/);
  assert.match(html, />Log in<\/button>/);
  const app = await readFile('reader/public/app.js', 'utf8');
  assert.match(app, /els\.userInfo\.textContent = 'Log in';/);
  assert.match(app, /els\.userInfo\.textContent = name;/);
  assert.match(html, /id="demo-dialog-host"/);
  // No new global navigation item was introduced for the admin view.
  assert.doesNotMatch(html, /id="admin-link"/);
  assert.equal((html.match(/id="account"/g) ?? []).length, 1);
  // Settings and the authorized Admin entry live inside the account region.
  assert.match(html, /<nav class="account-nav" aria-label="Account views">/);
  assert.match(html, /data-account-view="settings"[^>]*>Settings</);
  assert.match(html, /data-account-view="admin"[^>]*hidden>Admin</);
  assert.match(html, /data-account-back[^>]*><span aria-hidden="true">←<\/span> Return to notes<\/a>/);
  const accountNav = html.match(/<nav class="account-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(accountNav);
  assert.doesNotMatch(accountNav, /data-account-back/);
  // The account region has no spine and no pane-close control.
  const account = html.slice(html.indexOf('id="account"'), html.indexOf('id="preview"'));
  assert.doesNotMatch(account, /pane-spine|pane-close|class="pane"/);
});

test('demo styling is namespaced, reuses the reader tokens and stays light', async () => {
  const css = await readFile('reader/public/styles.css', 'utf8');
  assert.match(css, /\.user-info-button \{/);
  assert.match(css, /\.note-content \.demo-row \{/);
  assert.match(css, /\.demo-dialog::backdrop/);
  const demoBlock = css.slice(css.indexOf('demo (local) ---'));
  assert.ok(demoBlock.length > 1000);
  assert.match(demoBlock, /var\(--surface-quiet\)/);

  // Nothing outside the token blocks hard-codes a page colour any more. The
  // old stylesheet had dark literals well past :root, so this is the assertion
  // that keeps a theme change from being a root-only change.
  const tokenEnd = css.indexOf('*,\n*::before');
  assert.ok(tokenEnd > 0, 'the token blocks must come first');
  const body = css.slice(tokenEnd);
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, 'the stylesheet must use semantic tokens');
  assert.doesNotMatch(body, /rgba\(/, 'the stylesheet must use semantic tokens');

  // The base stylesheet holds one default token block; templates are files.
  assert.equal((css.match(/:root\[data-appearance=/g) ?? []).length, 0);
  for (const id of ['paper', 'lilac', 'minimal', 'things', 'blue-topaz', 'dark', 'khan', 'editorial']) {
    const theme = await readFile(`reader/public/themes/${id}.css`, 'utf8');
    assert.match(theme, new RegExp(`:root\\[data-appearance="${id}"\\]`));
    assert.doesNotMatch(theme, /prefers-color-scheme:\s*dark/);
    assert.doesNotMatch(theme, /@import|url\(/);
  }
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/);
});
