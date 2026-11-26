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

/* ---------------------------------------------- renderer: inline activity --- */

/** The renderer only needs note lookup; a callout test needs no real vault. */
function stubVault(notes = {}) {
  return {
    resolveNote: (name) => {
      const id = String(name).trim();
      return notes[id] ? { id, title: notes[id] } : null;
    },
    resolveAsset: () => null,
  };
}

test('an activity callout renders as a static section: prompt, anchor and rewritten links', () => {
  const render = createRenderer(stubVault({ 'Base Note': 'Vitruvian' }));
  const html = render({
    id: 'Orientation',
    body: [
      '# Orientation',
      '',
      '> [!activity] What brought you here?',
      '> Is there something you hope to do differently? See [[Base Note|the home page]].',
      '>',
      '> A second paragraph stays its own paragraph.',
      '',
      '> An ordinary quote with [[Base Note]].',
    ].join('\n'),
  });

  // The section, its title attribute and its heading anchor all agree.
  assert.match(html, /<section class="inline-activity" data-activity-title="What brought you here\?" data-activity-id="what-brought-you-here" aria-labelledby="what-brought-you-here">/);
  assert.match(html, /<h2 class="inline-activity-title" id="what-brought-you-here">What brought you here\?<\/h2>/);
  assert.match(html, /<div class="inline-activity-prompt">/);

  // The prompt keeps its own paragraphs, and its links still resolve.
  assert.match(html, /<p>Is there something you hope to do differently\? See <a class="note-link" href="\/Base%20Note" data-note-id="Base Note">the home page<\/a>\.<\/p>/);
  assert.match(html, /<p>A second paragraph stays its own paragraph\.<\/p>/);

  // An ordinary blockquote is untouched.
  assert.match(html, /<blockquote>\n<p>An ordinary quote with <a class="note-link" href="\/Base%20Note" data-note-id="Base Note">Base Note<\/a>\.<\/p>\n<\/blockquote>/);

  // The Markdown carries no control: the reader adds the form, never the note.
  assert.doesNotMatch(html, /<form|<textarea|<button/);
});

test('an activity title is escaped in the attribute and in the heading', () => {
  const render = createRenderer(stubVault());
  const html = render({
    id: 'Escapes',
    body: '> [!activity] He said "hello" & <b>bold</b> <script>alert(1)</script>\n> Body.',
  });
  assert.doesNotMatch(html, /<script>|<b>/);
  assert.match(html, /data-activity-title="He said &quot;hello&quot; &amp; &lt;b&gt;bold&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(html, /<h2 class="inline-activity-title" id="[^"]+">He said &quot;hello&quot; &amp; &lt;b&gt;bold&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h2>/);
});

test('two activities with the same title get distinct, matching anchors', () => {
  const render = createRenderer(stubVault());
  const html = render({
    id: 'Twice',
    body: [
      '> [!activity] Notice this',
      '> First.',
      '',
      '> [!activity] Notice this',
      '> Second.',
    ].join('\n'),
  });
  const headingIds = [...html.matchAll(/<h2 class="inline-activity-title" id="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(headingIds, ['notice-this', 'notice-this-1']);
  assert.deepEqual([...html.matchAll(/data-activity-id="([^"]+)"/g)].map((match) => match[1]), headingIds);
  assert.deepEqual([...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]), headingIds);
});

test('a non-activity callout stays an ordinary blockquote', () => {
  const render = createRenderer(stubVault());
  const html = render({
    id: 'Plain',
    body: '> [!note] Not an activity\n> Keep as a quote.\n\n> [!activity] Real activity\n> Answered here.',
  });
  assert.match(html, /<blockquote>\n<p>\[!note\] Not an activity\nKeep as a quote\.<\/p>\n<\/blockquote>/);
  assert.equal((html.match(/class="inline-activity"/g) ?? []).length, 1);
  assert.match(html, /data-activity-title="Real activity"/);
});

/* -------------------------------------------------------- renderer: charts --- */

test('a chart callout renders a card, and the Markdown itself carries no frame', () => {
  const render = createRenderer(stubVault({ 'Base Note': 'Vitruvian' }));
  const html = render({
    id: 'World data',
    body: [
      '# World data',
      '',
      '> [!chart] How many people live in the world',
      '> The United Nations estimates every country each year. See [[Base Note|the home page]].',
      '> https://ourworldindata.org/grapher/population-and-demography?tab=map&country=CHN~IND~USA',
      '',
      '> An ordinary quote stays a quote.',
    ].join('\n'),
  });

  // The card, its title, its caption and its source link all come from the note.
  assert.match(html, /<figure class="chart-embed" data-chart-src="https:\/\/ourworldindata\.org\/grapher\/population-and-demography\?tab=map&amp;country=CHN~IND~USA" data-chart-title="How many people live in the world">/);
  assert.match(html, /<figcaption class="chart-embed-head"><p class="chart-embed-title">How many people live in the world<\/p>/);
  assert.match(html, /<p class="chart-embed-text">The United Nations estimates every country each year\. See <a class="note-link" href="\/Base%20Note" data-note-id="Base Note">the home page<\/a>\.<\/p>/);
  assert.match(html, /<div class="chart-embed-body"><\/div>/);
  assert.match(html, /<a class="chart-embed-link" href="https:\/\/ourworldindata\.org\/grapher\/population-and-demography\?tab=map&amp;country=CHN~IND~USA" rel="noreferrer noopener" target="_blank">Our World in Data<\/a>/);
  // The link is the embed source, never caption text.
  assert.doesNotMatch(html, /chart-embed-text">[^<]*ourworldindata/);
  // The reader mounts the frame, so the published Markdown holds none: a hover
  // preview of this note can therefore fetch nothing.
  assert.doesNotMatch(html, /<iframe|<script|<form|<textarea|<button/);
  assert.match(html, /<blockquote>\n<p>An ordinary quote stays a quote\.<\/p>\n<\/blockquote>/);
});

test('only Our World in Data grapher links become charts', () => {
  const render = createRenderer(stubVault());
  const allowed = [
    'https://ourworldindata.org/grapher/life-expectancy',
    'https://www.ourworldindata.org/grapher/life-expectancy?tab=chart&country=World',
    'https://OURWORLDINDATA.ORG/grapher/life-expectancy',
    'https://archive.ourworldindata.org/20261124-173438/grapher/population-and-demography.html?tab=map',
  ];
  for (const url of allowed) {
    const html = render({ id: 'Allowed', body: `> [!chart] A chart\n> ${url}` });
    assert.equal((html.match(/class="chart-embed"/g) ?? []).length, 1, url);
    assert.match(html, /<div class="chart-embed-body"><\/div>/, url);
  }

  const refused = [
    'http://ourworldindata.org/grapher/life-expectancy',
    '//ourworldindata.org/grapher/life-expectancy',
    'https://ourworldindata.org:8443/grapher/life-expectancy',
    'https://ourworldindata.org./grapher/life-expectancy',
    'https://ourworldindata.org.evil.example/grapher/life-expectancy',
    'https://ourworldindata.org/grapher/life-expectancy.metadata.json',
    'https://ourworldindata.org/grapher/life-expectancy.csv',
    'https://ourworldindata.org/grapher/',
    'https://ourworldindata.org/other-page',
    'https://ourworldindata.org/grapher/../../other',
    'https://example.com/grapher/life-expectancy',
    'https://archive.ourworldindata.org/grapher/life-expectancy.html',
    'https://user:pass@ourworldindata.org/grapher/life-expectancy',
    'javascript:alert(1)',
    'not a url',
  ];
  for (const url of refused) {
    const html = render({ id: 'Refused', body: `> [!chart] A chart\n> ${url}` });
    assert.equal((html.match(/class="chart-embed"/g) ?? []).length, 0, url);
    assert.match(html, /data-chart-unsupported="true"/, url);
    assert.doesNotMatch(html, /<iframe|data-chart-src|<a /, url);
  }

  // The link that did not qualify is shown as escaped text, never as a link.
  const shown = render({ id: 'Shown', body: '> [!chart] A chart\n> https://example.com/grapher/x?a=1&b="2"' });
  assert.match(shown, /The link here was https:\/\/example\.com\/grapher\/x\?a=1&amp;b=&quot;2&quot;\./);
  assert.doesNotMatch(shown, /<a /);
});

test('a chart callout keeps its chart across a blank quote line', () => {
  const render = createRenderer(stubVault());
  const html = render({
    id: 'Blank',
    body: [
      '> [!chart] How many people live in the world',
      '>',
      '> The United Nations estimates every country each year.',
      '>',
      '> https://ourworldindata.org/grapher/population-and-demography',
    ].join('\n'),
  });
  assert.equal((html.match(/class="chart-embed"/g) ?? []).length, 1);
  assert.match(html, /data-chart-src="https:\/\/ourworldindata\.org\/grapher\/population-and-demography"/);
  assert.match(html, /<p class="chart-embed-text">The United Nations estimates every country each year\.<\/p>/);
  assert.doesNotMatch(html, /data-chart-unsupported/);
});

test('a chart callout without a link, and a chart title with markup, stay inert', () => {
  const render = createRenderer(stubVault());
  const escaped = render({
    id: 'Escapes',
    body: '> [!chart] He said "hello" & <b>bold</b> <script>alert(1)</script>\n> Caption <img src=x onerror=alert(1)>.\n> https://ourworldindata.org/grapher/life-expectancy',
  });
  assert.doesNotMatch(escaped, /<script>|<b>|<img/);
  assert.match(escaped, /data-chart-title="He said &quot;hello&quot; &amp; &lt;b&gt;bold&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(escaped, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const missing = render({ id: 'Missing', body: '> [!chart] A chart\n> No link here.' });
  assert.equal((missing.match(/class="chart-embed"/g) ?? []).length, 0);
  assert.match(missing, /data-chart-unsupported="true"/);

  // A callout with a different name is untouched.
  const plain = render({ id: 'Plain', body: '> [!note] Not a chart\n> Keep as a quote.' });
  assert.match(plain, /<blockquote>\n<p>\[!note\] Not a chart\nKeep as a quote\.<\/p>\n<\/blockquote>/);
});

test('chart cards are styled', async () => {
  const css = await readFile('reader/public/styles.css', 'utf8');
  // The renderer's class names and the stylesheet must keep agreeing.
  for (const selector of ['.note-content .chart-embed {', '.note-content .chart-embed-frame {', '.note-content .chart-embed-unsupported {', '.note-content .chart-embed-body:empty {']) {
    assert.ok(css.includes(selector), `${selector} must be styled`);
  }

});

test('every subject note links to a heading that exists in World data', async () => {
  const vault = await loadVault('vault');
  const render = createRenderer(vault);
  const worldData = render(vault.notes.get('World data'));
  const headings = new Set([...worldData.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]));
  assert.equal(headings.size, 6);
  // Six charts, each one an Our World in Data grapher link.
  assert.equal((worldData.match(/data-chart-src="https:\/\/ourworldindata\.org\/grapher\//g) ?? []).length, 6);
  assert.doesNotMatch(worldData, /<iframe/);

  const linked = new Set();
  for (const id of ['Physical wellness', 'Mental Health', 'Intillectual', 'financial wellness', 'social skills']) {
    const note = vault.notes.get(id);
    assert.ok(note, `${id} must exist`);
    const matches = [...render(note).matchAll(/data-note-id="World data" data-heading="([^"]+)"/g)];
    assert.equal(matches.length, 1, `${id} should link to one World data heading`);
    linked.add(matches[0][1]);
  }
  assert.equal(linked.size, 5, 'each subject points at its own section');
  for (const heading of linked) assert.ok(headings.has(heading), `${heading} must be a heading in World data`);
});

/* --------------------------------------------------- build: activity flag --- */

test('the build publishes only a boolean activity flag and no raw frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitruvian-vault-'));
  const out = await mkdtemp(join(tmpdir(), 'vitruvian-out-'));
  try {
    await writeFile(join(root, 'Base Note.md'), '# Base Note\n');
    await writeFile(join(root, 'Breath.md'), '---\nactivity: true\n---\n# Breath\n');
    await writeFile(join(root, 'Movement.md'), '---\nactivity: "true"\nparents: ["Base Note"]\n---\n# Movement\n');
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
      'activity', 'backlinks', 'breadcrumbs', 'html', 'id', 'links', 'obsidianUrl', 'source', 'text', 'title',
    ]);
    assert.deepEqual(built.notes.Movement.breadcrumbs.map((crumb) => crumb.id), ['Base Note']);
    assert.deepEqual(built.notes['Base Note'].breadcrumbs, []);
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
    assert.match(shell, /href="\.\/activity-collection\.css"/);
    for (const asset of ['activity-catalog.js', 'activity-collection.js', 'activity-collection.css', 'chart-embed.js']) {
      assert.equal(await readFile(join(out, asset), 'utf8'), await readFile(join('reader/public', asset), 'utf8'),
        `${asset} ships unchanged on the static project path`);
    }
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
  assert.equal((html.match(/<button[^>]*settings-button/g) ?? []).length, 1);
  assert.match(html, /id="settings-button"/);
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /id="login-link"[^>]*>Log in<\/button>/);
  const app = await readFile('reader/public/app.js', 'utf8');
  assert.match(app, /els\.settings\.addEventListener\('click', \(\) => goToView\(VIEW_SETTINGS\)\);/);
  assert.match(app, /els\.login\.addEventListener\('click', openUserInfo\);/);
  assert.match(html, /id="demo-dialog-host"/);
  // No new global navigation item was introduced for the admin view.
  assert.doesNotMatch(html, /id="admin-link"/);
  assert.equal((html.match(/id="account"/g) ?? []).length, 1);
  // Settings and the authorized Admin entry live inside the account region.
  assert.match(html, /<nav class="account-nav" aria-label="Account views">/);
  assert.match(html, /data-account-view="account"[^>]*>User</);
  assert.doesNotMatch(html, />User info</);
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

test('account first paint precedes async startup and Settings does not await database init', async () => {
  const app = await readFile('reader/public/app.js', 'utf8');
  const ui = await readFile('reader/public/demo-ui.js', 'utf8');
  const render = app.slice(app.indexOf('async function renderAccountView'), app.indexOf('function focusAccountHeading'));
  assert.ok(render.indexOf('replaceChildren(createAccountLoadingView(') >= 0);
  assert.ok(render.indexOf('replaceChildren(createAccountLoadingView(') < render.indexOf('await demoBoot'));
  const pane = ui.slice(ui.indexOf('async function renderPane('), ui.indexOf('/* ---------------------------------------------------- inline activities'));
  assert.ok(pane.indexOf("if (view === 'settings')") >= 0);
  assert.ok(pane.indexOf('buildSettingsView()') < pane.indexOf('await init()'));
  assert.ok(pane.indexOf('replaceChildren(createAccountLoadingView(') < pane.indexOf('await init()'));
  assert.ok(pane.indexOf('replaceChildren(createAccountLoadingView(') < pane.indexOf('await loadAccountData()'));
  // Explicit account navigation targets the history heading, never the note's
  // retained reading fragment. Behavioral focus/scroll coverage is in Playwright.
  assert.match(render, /state\.accountSection === 'activity-history'/);
  assert.match(render, /querySelector\('#activity-history h2'\)/);
  assert.match(render, /historyHeading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(render, /els\.account\.scrollTo/);
});

test('demo styling is namespaced, reuses the reader tokens and stays light', async () => {
  const css = await readFile('reader/public/styles.css', 'utf8');
  assert.match(css, /\.header-icon-button,/);
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
