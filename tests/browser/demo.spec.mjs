/**
 * Browser workflows for the local participation demo, plus the reader
 * regressions the demo must not break.
 *
 *   npm run test:browser
 *
 * The suite builds `dist/`, serves it over HTTP (also under a project prefix, to
 * stand in for GitHub Pages), and drives it with Playwright. Each test gets a
 * fresh browser context, so every test starts with an empty IndexedDB.
 *
 * The account views (User, Settings, Admin) are a full-page region beside
 * the reader, not panes in the stack, so they are addressed through
 * `#account` / `#account-content` rather than `lastPane()`.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DEMO_VERIFICATION_CODE } from '../../reader/public/demo-model.js';
import { config, repoRoot, resolvePlaywright, baseUrlFor } from '../../playwright.config.mjs';

const run = promisify(execFile);
const playwright = await resolvePlaywright();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** A 1x1 PNG, so the evidence preview has a real image to show. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const ACCOUNT_TITLES = { account: 'User', settings: 'Settings', admin: 'Admin' };

if (!playwright) {
  test('browser tests need Playwright', { skip: 'Playwright was not found; set PLAYWRIGHT_MODULE to playwright/index.mjs' }, () => {});
}

let server;
let browser;

before(async () => {
  if (!playwright) return;
  if (!config.skipBuild) await run(process.execPath, ['scripts/build.mjs'], { cwd: repoRoot });

  server = createServer(async (request, response) => {
    try {
      let pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname.startsWith(config.projectPath)) pathname = pathname.slice(config.projectPath.length);
      if (!pathname.startsWith('/')) pathname = `/${pathname}`;
      // The site ships no favicon; answer it here so the tests do not trip on a
      // console 404 that has nothing to do with the reader.
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      // The browser suite exercises the local demo; production configuration is
      // covered by the unit tests and the real deployment.
      if (pathname === '/supabase-config.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ mode: 'local' }));
        return;
      }
      let filePath = join(repoRoot, 'dist', normalize(pathname));
      if (pathname.endsWith('/')) filePath = join(filePath, 'index.html');
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(await readFile(filePath));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve));

  const launch = { headless: config.headless };
  if (config.channel) launch.channel = config.channel;
  browser = await playwright.chromium.launch(launch);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

/* ---------------------------------------------------------------- helpers --- */

/** A fresh, isolated context: its own IndexedDB, cookies and storage. */
async function openPage({
  viewport = config.viewport,
  url = '/',
  initScript = null,
  reading = null,
  reducedMotion = null,
  colorScheme = null,
} = {}) {
  const context = await browser.newContext({
    viewport,
    baseURL: baseUrlFor(),
    hasTouch: false,
    ...(reducedMotion ? { reducedMotion } : {}),
    ...(colorScheme ? { colorScheme } : {}),
  });
  if (initScript) await context.addInitScript(initScript);
  if (reading) {
    await context.addInitScript((mode) => {
      localStorage.setItem('vitruvian.reading', mode);
    }, reading);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Resource-loading noise — a revoked blob URL, a missing favicon — is not a
    // script error. Anything the reader's own code throws still fails the test.
    if (/Failed to load resource/.test(message.text())) return;
    errors.push(new Error(message.text()));
  });
  await page.goto(url);
  return { context, page, errors };
}

const stack = (page) => page.locator('#stack');
const lastPane = (page) => page.locator('.stack > .pane').last();
/** The full-page account region and its content, never a `.pane`. */
const accountRegion = (page) => page.locator('#account');
const accountBody = (page) => page.locator('#account-content');
const paneCount = (page) => page.locator('.stack > .pane').count();

const currentView = (page) =>
  page.evaluate(() => new URL(location.href).searchParams.get('view') ?? 'reader');

async function waitForNote(page, title = null) {
  await page.waitForFunction((expected) => {
    const pane = document.querySelector('.stack > .pane:last-child');
    if (!pane) return false;
    const content = pane.querySelector('.note-content');
    if (!content || content.hasAttribute('aria-busy') || content.childElementCount === 0) return false;
    return expected ? (pane.getAttribute('aria-label') || '') === expected : true;
  }, title);
}

/** Wait for the account region, and for the named view's heading. */
async function waitForAccountView(page, view = 'account') {
  await accountRegion(page).waitFor();
  await page.waitForFunction((expected) => {
    const heading = document.querySelector('#account-content h1');
    return Boolean(heading) && heading.textContent.trim() === expected
      && !document.querySelector('#account-content .account-loading');
  }, ACCOUNT_TITLES[view] ?? view);
  return accountBody(page);
}

/** Open an account view through the header entry and the region's own nav. */
async function goToView(page, view = 'account') {
  if (!(await accountRegion(page).isVisible())) {
    // The gear opens Settings; a guest's Log in opens the account tab.
    if (await page.locator('#login-link').isVisible()) await page.click('#login-link');
    else await page.click('#settings-button');
    await accountRegion(page).waitFor();
  }
  if ((await currentView(page)) !== view) {
    await page.locator(`#account [data-account-view="${view}"]`).click();
  }
  await page.waitForFunction((expected) => {
    return (new URL(location.href).searchParams.get('view') ?? 'reader') === expected;
  }, view);
  return waitForAccountView(page, view);
}

/** The account view and the sign-in dialog share one form; this fills either. */
async function completeSignIn(scope, email) {
  await scope.locator('input[type="email"]').fill(email);
  await scope.getByRole('button', { name: 'Continue' }).click();
  await scope.locator('.demo-code-value').waitFor();
  await scope.locator('input[type="text"]').fill(DEMO_VERIFICATION_CODE);
  await scope.getByRole('button', { name: 'Sign in' }).click();
}

async function signInFromAccount(page, email) {
  const body = await goToView(page, 'account');
  await body.locator('.demo-signin').waitFor();
  await completeSignIn(body, email);
  await body.locator('.demo-facts').waitFor();
  return body;
}

/** Count vessel paths, not the decorative legend's SVG paths. */
async function assertCollection(page, count, { subject = null, format = null } = {}) {
  const collection = accountBody(page).locator('.activity-collection');
  await collection.locator(`.activity-collection-count[data-count="${count}"]`).waitFor();
  await page.waitForFunction((expected) =>
    document.querySelectorAll('#account-content .activity-collection-svg path').length === Math.min(expected, 160), count);
  assert.equal(await collection.locator('.activity-collection-count').textContent(), `${count} ${count === 1 ? 'activity' : 'activities'}`);
  if (subject) assert.equal(await collection.locator(`.activity-collection-legend-item[data-subject="${subject}"]`).getAttribute('data-count'), String(count));
  if (format) assert.equal(await collection.locator(`.activity-collection-format[data-format="${format}"]`).textContent(), `${format[0].toUpperCase()}${format.slice(1)} ${count}`);
  assert.doesNotMatch(await collection.textContent(), /%|score|goal|streak|ranking/i);
  return collection;
}

async function assertUserSkeleton(page) {
  const loading = accountBody(page).locator('.account-loading');
  await loading.waitFor();
  assert.equal(await loading.getAttribute('aria-busy'), 'true');
  assert.equal(await loading.locator('h1').textContent(), 'User');
  assert.deepEqual(await loading.locator('h2').allTextContents(), [
    'Your collection', 'Activity history', 'Pinned portfolio', 'Your reading', 'Vitruvian scholarship',
  ]);
  assert.ok(await loading.locator('.account-loading-bar[aria-hidden="true"]').count() >= 8);
  assert.equal(await accountBody(page).locator('.demo-row, .activity-collection-count, .demo-facts').count(), 0,
    'no invented counts or stale private rows while loading');
}

async function openActivityDialog(page) {
  await page.locator('button.demo-log-activity').click();
  const dialog = page.locator('dialog.demo-dialog-activity');
  await dialog.waitFor();
  return dialog;
}

async function logActivity(page, { reflection = '', files = [] } = {}) {
  const dialog = await openActivityDialog(page);
  if (reflection) await dialog.locator('textarea').fill(reflection);
  if (files.length) await dialog.locator('input[type="file"]').setInputFiles(files);
  await dialog.getByRole('button', { name: 'Save as pending' }).click();
  return dialog;
}

/** Read the demo's own IndexedDB, so statistics can be asserted exactly. */
async function readDemoData(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('vitruvian-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (store) => new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [accounts, stats] = await Promise.all([readAll('accounts'), readAll('stats')]);
    db.close();
    return { accounts, stats };
  });
}

async function statsFor(page, email) {
  const { accounts, stats } = await readDemoData(page);
  const account = accounts.find((record) => record.email === email);
  assert.ok(account, `the local account ${email} must exist`);
  return stats.find((record) => record.accountId === account.id) ?? { pages: {}, activeMs: 0 };
}

/** Every stored submission for one local account, read straight from IndexedDB. */
async function submissionsFor(page, email) {
  const { accounts } = await readDemoData(page);
  const account = accounts.find((record) => record.email === email);
  assert.ok(account, `the local account ${email} must exist`);
  return page.evaluate(async (accountId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('vitruvian-demo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction('submissions', 'readonly').objectStore('submissions').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.filter((row) => row.accountId === accountId);
  }, account.id);
}

/* ------------------------------------------------------------------ tests --- */

test('User is a full-page account region, not a pane in the stack', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    assert.equal(await paneCount(page), 1);

    await page.click('#login-link');
    const body = await waitForAccountView(page, 'account');

    // The region is exposed; the reading stack is hidden but still mounted.
    assert.equal(await accountRegion(page).isVisible(), true);
    assert.equal(await stack(page).isVisible(), false);
    assert.equal(await paneCount(page), 1, 'the note pane is kept, not replaced');
    assert.equal(await page.locator('#account .pane').count(), 0, 'an account view is never a pane');
    assert.equal(await page.locator('.pane[data-note-id^="demo:"]').count(), 0);

    // The reading query parameters survive; `view` is the only addition.
    assert.equal(await currentView(page), 'account');
    assert.match(page.url(), /note=Base(%20|\+)Note/);
    assert.equal((await body.locator('h1.demo-title').textContent()).trim(), 'User');
    assert.match(await body.textContent(), /Insecure local-only demo/);
    assert.match(await body.textContent(), /no server, no real authentication and no email/);

    // Settings and Admin live inside the region, never in global navigation.
    assert.equal(await page.locator('header button', { hasText: 'Admin' }).count(), 0);
    assert.equal(await page.locator('header a', { hasText: 'Settings' }).count(), 0);
    assert.equal(await page.locator('#account [data-account-view="settings"]').count(), 1);
    assert.equal(await page.locator('#account [data-account-view="admin"]').isVisible(), false,
      'the admin entry is hidden until an admin is signed in');

    // Signing in states the demo limits and keeps the reader working.
    await body.locator('input[type="email"]').fill('not-an-email');
    await body.getByRole('button', { name: 'Continue' }).click();
    assert.match(await body.locator('.demo-error:visible').textContent(), /does not look like an email/);

    await body.locator('input[type="email"]').fill('Ada@Example.com');
    await body.getByRole('button', { name: 'Continue' }).click();
    // The code is on screen because there is no email delivery.
    assert.equal((await body.locator('.demo-code-value').textContent()).trim(), DEMO_VERIFICATION_CODE);

    await body.locator('input[type="text"]').fill('000000');
    await body.getByRole('button', { name: 'Sign in' }).click();
    assert.match(await body.locator('.demo-error:visible').textContent(), /does not match/);

    await body.locator('input[type="text"]').fill(DEMO_VERIFICATION_CODE);
    await body.getByRole('button', { name: 'Sign in' }).click();
    await body.locator('.demo-facts').waitFor();

    assert.match(await body.textContent(), /Signed in as ada@example\.com/);
    assert.match(await body.textContent(), /Local estimate, measured in this browser only/);
    assert.match(await body.textContent(), /Nothing pinned yet\./);
    assert.match(await body.textContent(), /No activity logged yet\./);
    assert.equal(await body.locator('a.demo-evidence-download').count(), 0);
    assert.equal(await paneCount(page), 1, 'signing in adds no pane');

    // Visiting every region leaves the reading stack exactly as it was: an
    // account view never enters `state.stack` and never renders as a pane.
    await goToView(page, 'settings');
    assert.equal(await paneCount(page), 1);
    assert.equal(await lastPane(page).getAttribute('data-note-id'), 'Base Note');
    assert.match(page.url(), /note=Base(%20|\+)Note/);
    assert.equal(await page.locator('.pane[data-note-id^="demo:"]').count(), 0);
    await goToView(page, 'account');
    assert.equal(await paneCount(page), 1);
    assert.equal(await lastPane(page).getAttribute('data-note-id'), 'Base Note');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Settings offers the appearance presets with no account at all', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    const body = await goToView(page, 'settings');
    assert.equal((await body.locator('h1.demo-title').textContent()).trim(), 'Settings');
    assert.equal(await body.locator('.demo-signin').count(), 0, 'Settings needs no session');

    const layout = body.locator('#demo-reading-mode');
    await layout.waitFor();
    assert.deepEqual(await layout.locator('option').allTextContents(), ['Page', 'Stacked tabs (advanced)']);
    assert.equal(await layout.inputValue(), 'page');
    assert.equal(await body.locator('label[for="demo-reading-mode"]').count(), 1);

    const select = body.locator('#demo-appearance');
    await select.waitFor();
    assert.deepEqual(
      await select.locator('option').allTextContents(),
      ['Clear', 'Paper', 'Soft Lilac', 'Minimal', 'Things', 'Blue Topaz', 'Dark (dark mode)', 'Academy (light)', 'Editorial (serif)'],
    );
    assert.equal(await select.inputValue(), 'clear');
    assert.equal(await select.evaluate((element) => element.tagName), 'SELECT');
    // The control is labelled, and its hint is associated.
    assert.equal(await body.locator('label[for="demo-appearance"]').count(), 1);
    assert.equal(await select.getAttribute('aria-describedby'), 'demo-appearance-hint');
    assert.equal(await body.locator('#demo-appearance-hint').count(), 1);

    // Random is opt-in: hidden by default, shown from Settings.
    assert.equal(await page.locator('#random-button').isVisible(), false);
    const random = body.locator('#demo-random');
    assert.equal(await random.isChecked(), false);
    await random.check();
    await page.waitForFunction(() => !document.querySelector('#random-button').hidden);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('logging an activity needs a reflection or a file, and lands as pending', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    const logButton = page.locator('button.demo-log-activity');
    assert.equal(await logButton.count(), 1);
    assert.equal((await logButton.textContent()).trim(), 'Log activity');

    // A signed-out reader is asked to sign in first, then the activity resumes.
    await logButton.click();
    const signInDialog = page.locator('dialog.demo-dialog-signin');
    await signInDialog.waitFor();
    await completeSignIn(signInDialog, 'reader@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    assert.match(await dialog.locator('.demo-dialog-title').textContent(), /Log activity — Breath/);
    assert.match(await dialog.textContent(), /2\.0 MB each/);
    assert.match(await dialog.textContent(), /never opened in the page/);

    // Neither a reflection nor a file: refused, with an associated error.
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.locator('.demo-error-summary').waitFor();
    assert.match(await dialog.locator('.demo-error-summary').textContent(), /Add a reflection or attach a file/);
    assert.equal(await dialog.locator('[aria-invalid="true"]').count(), 0, 'neither field is wrong on its own');

    await dialog.locator('textarea').fill('  Two slow breaths before the first meeting.  ');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('#status').textContent(), /Activity logged and saved as pending review/);

    const savedLink = page.locator('a.activity-log-link');
    await savedLink.waitFor();
    assert.equal(await savedLink.textContent(), 'View activity log');
    await savedLink.click();
    const body = await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'physical', format: 'practice' });
    assert.deepEqual(await body.locator('#activity-history .activity-tag').allTextContents(), ['Physical', 'Practice']);
    await page.waitForFunction(() => document.activeElement === document.querySelector('#activity-history h2'));
    await body.locator('.demo-row').waitFor();
    assert.equal(await body.locator('.demo-row').count(), 1);
    assert.equal((await body.locator('.demo-status').first().textContent()).trim(), 'Pending');
    assert.match(await body.textContent(), /Two slow breaths before the first meeting\./);
    assert.match(await body.textContent(), /No review yet\./);
    assert.equal(await paneCount(page), 1);

    // A note without `activity: true` never grows the control.
    await page.goto('/?note=Base Note');
    await waitForNote(page);
    assert.equal(await page.locator('button.demo-log-activity').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a signed-out reader can save an activity locally, then merge it on sign-in', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Movement' });
  try {
    await waitForNote(page, 'Movement');
    await page.locator('button.demo-log-activity').click();
    const signIn = page.locator('dialog.demo-dialog-signin');
    await signIn.waitFor();
    await signIn.getByRole('button', { name: 'Save on this device' }).click();

    const guest = page.locator('dialog.demo-dialog-activity');
    await guest.waitFor();
    await guest.locator('textarea').fill('Walked around the block.');
    await guest.getByRole('button', { name: 'Save on this device' }).click();
    await guest.waitFor({ state: 'detached' });
    await page.locator('.demo-guest-marker').waitFor();
    const logLink = page.locator('a.activity-log-link');
    await logLink.waitFor();
    assert.equal(await logLink.textContent(), 'View activity log');
    await logLink.click();
    await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'physical', format: 'practice' });
    assert.deepEqual(await accountBody(page).locator('#activity-history .activity-tag').allTextContents(), ['Physical', 'Practice']);
    assert.equal(await accountBody(page).locator('#activity-history .demo-status').textContent(), 'Saved on this device');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Activity history');
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('#activity-history').compareDocumentPosition(document.querySelector('.demo-signin')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.locator('#account-back').click();

    await page.reload();
    await waitForNote(page, 'Movement');
    assert.equal(await page.locator('.demo-guest-marker').count(), 1);

    const body = await goToView(page, 'account');
    await body.getByText('Saved on this device', { exact: true }).waitFor();
    assert.match(await body.textContent(), /Walked around the block\./);

    await completeSignIn(body, 'guest@example.com');
    await body.locator('.demo-row .demo-status').filter({ hasText: /^Pending$/ }).waitFor();
    await assertCollection(page, 1, { subject: 'physical', format: 'practice' });
    assert.equal((await body.locator('.demo-status').first().textContent()).trim(), 'Pending');
    assert.match(await body.textContent(), /Walked around the block\./);
    assert.equal(await page.evaluate(() => localStorage.getItem('vitruvian.guest-activities')), '[]');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('evidence: images preview, other files download, uploaded markup never runs', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Movement' });
  try {
    await waitForNote(page, 'Movement');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'evidence@example.com');

    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('input[type="file"]').setInputFiles([
      { name: 'walk.png', mimeType: 'image/png', buffer: TINY_PNG },
      { name: 'payload.html', mimeType: 'text/html', buffer: Buffer.from('<img src=x onerror="window.__pwned = true">') },
    ]);
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    const body = await goToView(page, 'account');
    await body.locator('.demo-evidence-image').waitFor();

    const preview = body.locator('.demo-evidence-image');
    assert.match(await preview.getAttribute('src'), /^blob:/);
    assert.equal(await body.locator('.demo-evidence').count(), 1);

    const download = body.locator('a.demo-evidence-download');
    assert.equal(await download.count(), 1);
    assert.match(await download.textContent(), /Download payload\.html/);
    assert.equal(await download.getAttribute('download'), 'payload.html');
    assert.match(await download.getAttribute('href'), /^blob:/);
    assert.equal(await body.locator('iframe').count(), 0, 'evidence is never framed');
    assert.equal(await page.evaluate(() => window.__pwned ?? null), null, 'uploaded markup never ran');

    // Leaving the region revokes the object URLs it created, so they cannot be
    // reused after the evidence is off screen.
    const previewSrc = await preview.getAttribute('src');
    await page.locator('#account-back').click();
    await waitForNote(page);
    const revoked = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, previewSrc);
    assert.equal(revoked, true, 'the evidence object URL must be revoked with its view');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the admin page reviews seeded participants and keeps a history', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    const account = await signInFromAccount(page, 'admin@vitruvian.demo');
    // The demo admin is an ordinary local account, and only it sees the entry.
    assert.match(await account.textContent(), /Local account in this browser/);
    assert.equal(await page.locator('#account [data-account-view="admin"]').isVisible(), true);
    await page.locator('#account [data-account-view="admin"]').click();

    const admin = await waitForAccountView(page, 'admin');
    assert.equal((await admin.locator('h1.demo-title').textContent()).trim(), 'Admin');
    assert.equal(await currentView(page), 'admin');
    assert.match(await admin.textContent(), /Local-only demo admin/);
    assert.match(await admin.textContent(), /Synthetic sample statistics/);
    assert.equal(await admin.locator('.demo-row').filter({ hasText: 'Ada — synthetic participant' }).count(), 1);

    // Verify a seeded pending submission.
    const row = admin.locator('.demo-row').filter({ hasText: 'Movement' }).first();
    assert.equal((await row.locator('.demo-status').textContent()).trim(), 'Pending');
    await row.locator('select').selectOption('verified');
    await row.getByRole('button', { name: 'Save review' }).click();
    await admin.locator('.demo-row').filter({ hasText: 'Movement' }).first()
      .locator('.demo-status').filter({ hasText: 'Verified' }).waitFor();
    assert.match(await page.locator('#status').textContent(), /Review saved: Verified/);

    // Requesting changes needs feedback, and then records it.
    const row2 = admin.locator('.demo-row').filter({ hasText: 'Movement' }).first();
    await row2.locator('select').selectOption('changes_requested');
    await row2.getByRole('button', { name: 'Save review' }).click();
    assert.match(await row2.locator('.demo-error').first().textContent(), /Add feedback when requesting changes/);
    await row2.locator('textarea').fill('Add one sentence about the walk.');
    await row2.getByRole('button', { name: 'Save review' }).click();
    await admin.locator('.demo-feedback').filter({ hasText: 'Add one sentence about the walk.' }).waitFor();

    const history = admin.locator('.demo-row').filter({ hasText: 'Movement' }).first().locator('.demo-history');
    await history.locator('summary').click();
    assert.equal(await history.locator('.demo-history-item').count(), 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a pinned portfolio and its history survive a reload, and accounts stay separate', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Money check-in' });
  try {
    await waitForNote(page, 'Money check-in');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'owner@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Wrote three lines at the end of the day.');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    let body = await goToView(page, 'account');
    await body.locator('.demo-row').waitFor();
    assert.equal(await body.locator('.demo-gallery-card').count(), 0);

    // Pin it, whatever its review status.
    const pin = body.getByRole('button', { name: /^Pin the/ });
    await pin.click();
    await body.locator('.demo-gallery-card').waitFor();
    assert.equal(await body.locator('.demo-gallery-card').count(), 1);
    assert.match(await body.locator('.demo-gallery-card').textContent(), /Wrote three lines/);
    // The pinned item is still in the history.
    assert.equal(await body.locator('.demo-row').count(), 1);

    await page.reload();
    body = await goToView(page, 'account');
    await body.locator('.demo-gallery-card').waitFor();
    assert.match(await body.textContent(), /Signed in as owner@example\.com/);
    assert.equal(await body.locator('.demo-gallery-card').count(), 1);
    assert.equal((await body.locator('.demo-fact-value').nth(1).textContent()).trim(), '1');

    // Account switching: another address sees nothing of the first account.
    await body.getByRole('button', { name: 'Sign out' }).click();
    await body.locator('.demo-signin').waitFor();
    await completeSignIn(body, 'someone-else@example.com');
    await body.locator('.demo-facts').waitFor();
    assert.match(await body.textContent(), /Signed in as someone-else@example\.com/);
    assert.match(await body.textContent(), /Nothing pinned yet\./);
    assert.match(await body.textContent(), /No activity logged yet\./);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('clearing local data asks for confirmation and restores the fixtures', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Money check-in' });
  try {
    await waitForNote(page, 'Money check-in');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'temp@example.com');
    const activity = page.locator('dialog.demo-dialog-activity');
    await activity.waitFor();
    await activity.locator('textarea').fill('Temporary.');
    await activity.getByRole('button', { name: 'Save as pending' }).click();
    await activity.waitFor({ state: 'detached' });

    const body = await goToView(page, 'account');
    await body.getByRole('button', { name: 'Clear local demo data' }).click();
    const confirm = page.locator('dialog.demo-dialog-confirm');
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await body.locator('.demo-row').count(), 1, 'cancel keeps the data');

    await body.getByRole('button', { name: 'Clear local demo data' }).click();
    await page.locator('dialog.demo-dialog-confirm').getByRole('button', { name: 'Clear local data' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor({ state: 'detached' });
    // Clearing also ends the local session, so the sign-in form comes back.
    await body.locator('.demo-signin').waitFor();
    assert.match(await page.locator('#status').textContent(), /Local demo data cleared/);
    assert.match(await page.locator('#status').textContent(), /Synthetic fixtures restored/);
    // The account really is gone: signing in again starts from nothing.
    await completeSignIn(body, 'temp@example.com');
    await body.locator('.demo-facts').waitFor();
    assert.match(await body.textContent(), /No activity logged yet\./);
    assert.match(await body.textContent(), /Nothing pinned yet\./);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('dialogs take focus, keep it, dismiss on Escape, and block reader shortcuts', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Money check-in' });
  try {
    await waitForNote(page, 'Money check-in');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'keys@example.com');

    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-labelledby'), await dialog.locator('.demo-dialog-title').getAttribute('id'));
    // Initial focus is the first field.
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');

    // Keyboard containment: Tab never reaches the reader behind the modal.
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      const escaped = await page.evaluate(() => {
        const active = document.activeElement;
        // Focus may leave for the browser chrome, which reports as <body>.
        if (!active || active === document.body || active === document.documentElement) return false;
        return !active.closest('dialog');
      });
      assert.equal(escaped, false, 'focus must not reach the reader while the modal is open');
    }

    // The reader's global shortcut must not steal focus while the modal is open.
    await page.keyboard.press('ControlOrMeta+k');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'search-input');

    // Escape dismisses and focus goes back to the control that opened it.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.className ?? ''), 'demo-button demo-button-primary demo-log-activity');

    // With the modal gone, the shortcut works again.
    await page.keyboard.press('ControlOrMeta+k');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('storage that is missing or full never stops the notes, and never loses input', { skip: !playwright }, async () => {
  // 1. No IndexedDB at all.
  const missing = await openPage({
    initScript: () => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    },
  });
  try {
    await waitForNote(missing.page);
    await missing.page.click('#login-link');
    const body = accountBody(missing.page);
    await body.locator('.demo-failure').waitFor();
    assert.match(await body.textContent(), /Account unavailable/);
    assert.match(await body.textContent(), /The notes themselves are unaffected\./);

    // Settings does not depend on the store, so it still works here.
    await missing.page.locator('#account [data-account-view="settings"]').click();
    await missing.page.waitForFunction(() =>
      document.querySelector('#account-content h1')?.textContent.trim() === 'Settings');
    await missing.page.locator('#account-content #demo-appearance').waitFor();

    // Notes keep working.
    await missing.page.click('#app-title');
    await waitForNote(missing.page);
    assert.deepEqual(missing.errors, []);
  } finally {
    await missing.context.close();
  }

  // 2. IndexedDB present, but the write fails as it would on a full disk.
  const full = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(full.page, 'Breath');
    await full.page.locator('button.demo-log-activity').click();
    await full.page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(full.page.locator('dialog.demo-dialog-signin'), 'full@example.com');
    const dialog = full.page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();

    await full.page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patchedPut(...args) {
        if (this.name === 'submissions') throw new DOMException('simulated quota', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });

    await dialog.locator('textarea').fill('Keep this text.');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.locator('.demo-error-summary').waitFor();
    assert.match(await dialog.locator('.demo-error-summary').textContent(), /no room left/);
    // The dialog stays open with the input preserved, and the save is usable again.
    assert.equal(await dialog.locator('textarea').inputValue(), 'Keep this text.');
    assert.equal(await dialog.getByRole('button', { name: 'Save as pending' }).isEnabled(), true);
    assert.deepEqual(full.errors, []);
  } finally {
    await full.context.close();
  }
});

test('reading statistics count distinct notes for the signed-in reader only', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    // Signed out: nothing is measured, and the account view says so.
    let body = await goToView(page, 'account');
    await body.locator('.demo-signin').waitFor();
    await completeSignIn(body, 'measured@example.com');
    await body.locator('.demo-facts').waitFor();
    assert.equal((await body.locator('.demo-fact-value').nth(1).textContent()).trim(), '0');

    // Two distinct notes, opened the way a reader would.
    await page.click('#app-title');
    await waitForNote(page);
    await page.locator('#search-input').fill('Movement');
    await page.locator('.search-result').first().click();
    await waitForNote(page, 'Movement');
    // Let the view write land before the account view reads the statistics.
    await page.waitForTimeout(200);

    // A preview is not a page, and neither is an account view.
    body = await goToView(page, 'account');
    await body.locator('.demo-facts').waitFor();
    assert.equal((await body.locator('.demo-fact-value').nth(1).textContent()).trim(), '2');
    assert.match(await body.locator('.demo-fact-value').first().textContent(), /^\d+[smh]/);
    assert.match(await body.textContent(), /Local estimate, measured in this browser only/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('account views accrue no reading time or pages, and a closed dialog cannot resume tracking', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    const body = await signInFromAccount(page, 'quiet@example.com');
    // The account view settles the tracker before it reads the statistics.
    const before = await statsFor(page, 'quiet@example.com');
    assert.ok(before.activeMs >= 0);

    // Stay on the account page, including through a dialog open and close: the
    // reader is hidden, so nothing may accrue and no page may be counted.
    await page.waitForTimeout(1_200);
    await body.getByRole('button', { name: 'Clear local demo data' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor();
    await page.waitForTimeout(1_200);
    await page.locator('dialog.demo-dialog-confirm').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor({ state: 'detached' });
    await page.waitForTimeout(2_000);

    const after = await statsFor(page, 'quiet@example.com');
    assert.equal(after.activeMs, before.activeMs, 'a hidden reader must not accrue time');
    assert.deepEqual(Object.keys(after.pages).sort(), Object.keys(before.pages).sort());
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Return to notes keeps the reading URL, stack, horizontal position and scroll offsets', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    reading: 'stacked',
    viewport: { width: 1000, height: 320 },
    url: '/?note=Orientation',
  });
  try {
    await waitForNote(page, 'Orientation');
    assert.equal(await paneCount(page), 1);

    const firstSheet = page.locator('.stack > .pane').first().locator('.pane-sheet');
    const offset = await firstSheet.evaluate((element) => {
      element.scrollTo(0, 10_000);
      return element.scrollTop;
    });
    assert.ok(offset > 20, 'the first pane must be scrollable for this test');

    await lastPane(page).locator('a[data-note-id="Base Note"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    const readingUrl = page.url();
    assert.equal(await paneCount(page), 2);

    // Mark the panes so a rebuild would be obvious, then move the row.
    await page.evaluate(() => {
      document.querySelectorAll('.stack > .pane').forEach((pane, index) => {
        pane.dataset.marker = String(index);
      });
    });
    // Read the row's position back after the geometry pass has settled: the
    // covered-pane classes nudge a sticky scroller, and the reader's place is
    // where it comes to rest, not the first value written.
    const stackLeft = await stack(page).evaluate(async (element) => {
      element.scrollLeft = Math.min(140, element.scrollWidth - element.clientWidth);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return element.scrollLeft;
    });
    assert.ok(stackLeft > 0, 'the row must be horizontally scrollable for this test');

    const body = await goToView(page, 'account');
    assert.match(page.url(), /view=account/);
    assert.equal(await stack(page).isVisible(), false);

    await page.locator('#account-back').click();
    await page.waitForFunction(() => !document.querySelector('#stack').hidden);
    await page.waitForFunction((expected) => location.href === expected, readingUrl);
    assert.equal(page.url(), readingUrl, 'Return removes only `view`');

    // The DOM was retained: the same panes, with no rebuild.
    assert.equal(await paneCount(page), 2);
    assert.equal(await page.locator('.stack > .pane[data-marker="0"]').count(), 1);
    assert.equal(await page.locator('.stack > .pane[data-marker="1"]').count(), 1);

    // The horizontal position and the note's scroll offset came back.
    assert.equal(await stack(page).evaluate((element) => element.scrollLeft), stackLeft);
    await page.waitForFunction((expected) => {
      const top = document.querySelector('.stack > .pane .pane-sheet')?.scrollTop ?? -1;
      return Math.abs(top - expected) <= 2;
    }, offset);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('account views work on direct load, reload, Back/Forward and a project subpath', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    reading: 'stacked',
    url: `${config.projectPath}/?note=Breath&stackedNotes=Movement&view=settings`,
  });
  try {
    const body = await waitForAccountView(page, 'settings');
    await body.locator('#demo-appearance').waitFor();
    // The reading parameters survived, under the prefix, and no note pane was built.
    assert.match(page.url(), /\/vitruvian\/\?note=Breath&stackedNotes=Movement&view=settings$/);
    assert.equal(await stack(page).isVisible(), false);
    assert.equal(await paneCount(page), 0, 'a direct account load does not build the reading stack');

    await page.reload();
    await waitForAccountView(page, 'settings');
    assert.match(page.url(), /view=settings$/);

    // Back/Forward describe the region that was on screen.
    await goToView(page, 'account');
    await page.locator('#account-content .demo-signin').waitFor();
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'settings');
    await waitForAccountView(page, 'settings');
    await page.goForward();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'account');
    await waitForAccountView(page, 'account');

    // Return to notes, then Back comes back to the region.
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await waitForNote(page, 'Movement');
    assert.equal(await paneCount(page), 2, 'the reading stack is built on return');
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'account');
    await waitForAccountView(page, 'account');
    assert.equal(await page.locator('.stack > .pane').first().isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an account view works, and returning to the notes explains itself, when the notes index fails', { skip: !playwright }, async () => {
  // The account region never needs the notes index, so `?view=settings` must
  // open on its own; returning to the reader must then say the notes could not
  // be loaded rather than leaving a blank stack.
  const context = await browser.newContext({ viewport: config.viewport, baseURL: baseUrlFor() });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.route('**/notes.json', (route) => route.abort());
  try {
    await page.goto('/?view=settings');
    await page.locator('#account-content h1').waitFor();
    assert.equal((await page.locator('#account-content h1').textContent()).trim(), 'Settings');

    await page.locator('#account-back').click();
    await page.waitForFunction(() => !document.querySelector('#stack').hidden);
    assert.equal(await page.locator('#stack > .stack-message').count(), 1);
    assert.match(await page.locator('#stack').innerText(), /could not be loaded/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an incomplete Supabase config explains itself in the account region and leaves the notes usable', { skip: !playwright }, async () => {
  const context = await browser.newContext({ viewport: config.viewport, baseURL: baseUrlFor() });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  let configRequests = 0;
  // The runtime config is a real fetch, not the static notes adapter. A bad
  // config must not silently fall back to local storage, and must not call out.
  await page.route('**/supabase-config.json', (route) => {
    configRequests += 1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'supabase', url: '', publishableKey: '' }),
    });
  });
  try {
    await page.goto('/');
    await waitForNote(page);
    assert.equal(configRequests, 1);

    await page.click('#login-link');
    await page.locator('#account-content h1').waitFor();
    assert.equal((await page.locator('#account-content h1').textContent()).trim(), 'Account unavailable');
    assert.match(await page.locator('#account-content').innerText(), /incomplete/i);
    assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a legacy demo pane URL is migrated to the full-page region, keeping the real notes', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    reading: 'stacked',
    url: '/?note=Breath&stackedNotes=demo%3Aaccount&stackedNotes=Movement',
  });
  try {
    const body = await waitForAccountView(page, 'account');
    await body.locator('.demo-signin').waitFor();
    // The reserved id is gone from the URL; the real notes stay, in order.
    assert.equal(await currentView(page), 'account');
    assert.doesNotMatch(page.url(), /demo/);
    assert.match(page.url(), /note=Breath&stackedNotes=Movement&view=account/);

    // Return to notes gives the reading stack the migration retained.
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await waitForNote(page, 'Movement');
    assert.equal(await paneCount(page), 2);
    assert.match(page.url(), /note=Breath&stackedNotes=Movement/);

    // The reserved ids cannot be opened as panes any more, even by hand.
    await page.goto('/?note=demo%3Aadmin');
    await waitForAccountView(page, 'admin');
    assert.equal(await paneCount(page), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Random and Search leave the account region and open notes', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    initScript: () => localStorage.setItem('vitruvian.random', 'on'),
  });
  try {
    await waitForNote(page);
    await goToView(page, 'settings');
    assert.equal(await stack(page).isVisible(), false);

    // Random works from an account view and comes back to the reader.
    await page.click('#random-button');
    await page.waitForFunction(() => !document.querySelector('#stack').hidden);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await page.waitForFunction(() => document.querySelectorAll('.stack > .pane').length === 1);
    await waitForNote(page);

    // Search works from an account view too.
    await goToView(page, 'account');
    await page.locator('#search-input').fill('Money check-in');
    await page.locator('.search-result').filter({ hasText: 'Money check-in' }).first().click();
    await page.waitForFunction(() => !document.querySelector('#stack').hidden);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await page.waitForFunction(() =>
      document.querySelector('.stack > .pane:last-child')?.dataset.noteId === 'Money check-in');
    await waitForNote(page, 'Money check-in');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('only the exposed region is focusable, and a view change moves focus to its heading', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ reading: 'stacked' });
  try {
    await waitForNote(page);
    // Two panes, so a pane-close control exists to test with.
    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();

    // In the reader, nothing in the account region is reachable or focusable.
    assert.equal(await accountRegion(page).isVisible(), false);
    assert.equal(await page.locator('#account-settings-link').isVisible(), false);
    assert.equal(await page.locator('#account-back').isVisible(), false);
    assert.equal(await page.locator('#account-content').isVisible(), false);

    // Opening a view moves focus to its heading.
    await page.click('#login-link');
    await page.waitForFunction(() =>
      document.activeElement?.tagName === 'H1' && document.activeElement.textContent.trim() === 'User');

    // In the account region the reader's own controls are not focusable.
    assert.equal(await stack(page).isVisible(), false);
    assert.equal(await page.locator('.pane-close').first().isVisible(), false);
    assert.equal(await lastPane(page).isVisible(), false);

    await page.locator('#account [data-account-view="settings"]').click();
    await page.waitForFunction(() =>
      document.activeElement?.tagName === 'H1' && document.activeElement.textContent.trim() === 'Settings');

    // Returning to the notes focuses the reader's own pane again.
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !document.querySelector('#stack').hidden);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.pane'))), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('appearance presets apply immediately, survive reload and stay light under an OS dark preference', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ colorScheme: 'dark' });
  try {
    await waitForNote(page);
    // The OS asks for dark; the reader is light anyway.
    assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appearance), 'clear');
    const clearBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(clearBg, 'rgb(245, 246, 248)');

    const body = await goToView(page, 'settings');
    const select = body.locator('#demo-appearance');
    await select.waitFor();

    // A theme is a separate stylesheet, so the attribute can be set before the
    // file has loaded. Wait for the colour it produces, not the attribute.
    const waitForBackground = (expected) => page.waitForFunction(
      (value) => getComputedStyle(document.body).backgroundColor === value, expected);

    // A preset applies immediately, to the whole page.
    await select.selectOption('paper');
    await waitForBackground('rgb(246, 241, 232)');
    const paperBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(paperBg, clearBg);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');

    // The choice survives a reload, and the reader stays light.
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.appearance === 'paper');
    await waitForBackground(paperBg);

    await goToView(page, 'settings');
    await page.locator('#demo-appearance').selectOption('lilac');
    await waitForBackground('rgb(246, 245, 250)');

    // Back to the default.
    await page.locator('#demo-appearance').selectOption('clear');
    await waitForBackground(clearBg);

    // Every preset keeps the layout identical: only colour tokens change.
    const widths = [];
    for (const preset of ['clear', 'paper', 'lilac']) {
      await page.locator('#demo-appearance').selectOption(preset);
      await page.waitForFunction((expected) => document.documentElement.dataset.appearance === expected, preset);
      widths.push(await page.evaluate(() => {
        const heading = document.querySelector('#account-content h1');
        const nav = document.querySelector('.account-nav');
        return [heading.getBoundingClientRect().width, nav.getBoundingClientRect().height];
      }));
    }
    assert.deepEqual(widths[1], widths[0]);
    assert.deepEqual(widths[2], widths[0]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a slow account render cannot overwrite a newer view', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    const body = await signInFromAccount(page, 'race@example.com');
    await page.locator('#account-back').click();
    await waitForNote(page, 'Breath');
    const saved = await logActivity(page, { reflection: 'Private row must disappear during the next load.' });
    await saved.waitFor({ state: 'detached' });
    await goToView(page);
    await body.locator('.demo-row').waitFor();
    assert.match(await body.textContent(), /Private row must disappear/);

    // Hold the first submissions read of the account view open, so one render is
    // still in flight when a newer one has already committed.
    await page.evaluate(() => {
      const patch = (prototype) => {
        const original = prototype.getAll;
        let delayed = false;
        prototype.getAll = function patchedGetAll(...args) {
          const real = original.apply(this, args);
          const storeName = this.objectStore ? this.objectStore.name : this.name;
          if (delayed || storeName !== 'submissions') return real;
          delayed = true;
          window.__delayedRead = true;
          const fake = {};
          real.onsuccess = () => {
            setTimeout(() => {
              fake.result = real.result;
              fake.onsuccess?.({ target: fake });
            }, 1_200);
          };
          real.onerror = () => {
            fake.error = real.error;
            fake.onerror?.({ target: fake });
          };
          return fake;
        };
      };
      patch(IDBObjectStore.prototype);
      patch(IDBIndex.prototype);
    });

    // A slow render of the account view starts, then Settings replaces it.
    await page.locator('#account [data-account-view="settings"]').click();
    await waitForAccountView(page, 'settings');
    await page.locator('#account [data-account-view="account"]').click();
    await assertUserSkeleton(page);
    await page.waitForFunction(() => window.__delayedRead === true);
    await page.locator('#account [data-account-view="settings"]').click();
    await waitForAccountView(page, 'settings');

    // The delayed account render resolves now; it must not replace the newer view.
    await page.waitForTimeout(1_600);
    assert.equal((await page.locator('#account-content h1.demo-title').textContent()).trim(), 'Settings');
    assert.equal(await currentView(page), 'settings');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an admin review reaches the participant’s pinned portfolio and history', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Money check-in' });
  try {
    await waitForNote(page, 'Money check-in');
    // The participant logs and pins a submission.
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'reviewed@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Wrote three lines at the end of the day.');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.locator('a.activity-log-link').click();
    let body = await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'financial', format: 'writing' });
    assert.deepEqual(await body.locator('#activity-history .activity-tag').allTextContents(), ['Financial', 'Writing']);
    await body.locator('.demo-row').waitFor();
    await body.getByRole('button', { name: /^Pin the/ }).click();
    await body.locator('.demo-gallery-card').waitFor();
    assert.match(await body.locator('.demo-gallery-card .demo-status').textContent(), /Pending/);
    await assertCollection(page, 1, { subject: 'financial', format: 'writing' });

    // The demo admin verifies it.
    await body.getByRole('button', { name: 'Sign out' }).click();
    await body.locator('.demo-signin').waitFor();
    await completeSignIn(body, 'admin@vitruvian.demo');
    await body.locator('.demo-facts').waitFor();
    await page.locator('#account [data-account-view="admin"]').click();
    const admin = await waitForAccountView(page, 'admin');
    const submissions = admin.locator('.demo-section').nth(1);
    const row = submissions.locator('.demo-row').filter({ hasText: 'reviewed@example.com' }).first();
    await row.locator('.demo-status').filter({ hasText: 'Pending' }).waitFor();
    await row.locator('select').selectOption('verified');
    await row.getByRole('button', { name: 'Save review' }).click();
    await row.locator('.demo-status').filter({ hasText: 'Verified' }).waitFor();

    // Back to User info, sign out, and sign back in as the participant.
    await page.locator('#account [data-account-view="account"]').click();
    body = await waitForAccountView(page, 'account');
    await body.getByRole('button', { name: 'Sign out' }).click();
    await body.locator('.demo-signin').waitFor();
    await completeSignIn(body, 'reviewed@example.com');

    // The pinned card and the history row agree with the review.
    await body.locator('.demo-gallery-card').waitFor();
    assert.match(await body.locator('.demo-gallery-card .demo-status').textContent(), /Verified/);
    assert.equal((await body.locator('.demo-row .demo-status').first().textContent()).trim(), 'Verified');
    await assertCollection(page, 1, { subject: 'financial', format: 'writing' });
    assert.deepEqual(await body.locator('#activity-history .activity-tag').allTextContents(), ['Financial', 'Writing']);
    await page.reload();
    await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'financial', format: 'writing' });
    assert.equal(await body.locator('#activity-history .demo-row').count(), 1);
    assert.equal(await body.locator('.demo-gallery-card').count(), 1);
    assert.equal(await body.locator('#activity-history .demo-status').textContent(), 'Verified');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('clearing local data discards pending reading time and leaves no orphan statistics', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    const body = await signInFromAccount(page, 'orphan@example.com');

    // Read a real note for a few seconds: below the 20s flush threshold.
    await page.click('#app-title');
    await waitForNote(page);
    await page.waitForTimeout(3_000);

    // Clear everything, including that unflushed stretch.
    await goToView(page, 'account');
    await body.getByRole('button', { name: 'Clear local demo data' }).click();
    await page.locator('dialog.demo-dialog-confirm').getByRole('button', { name: 'Clear local data' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor({ state: 'detached' });
    await page.waitForTimeout(600);

    const { accounts, stats } = await readDemoData(page);

    assert.equal(accounts.some((account) => account.email === 'orphan@example.com'), false);
    const accountIds = new Set(accounts.map((account) => account.id));
    assert.ok(stats.every((record) => accountIds.has(record.accountId)),
      'no statistics row may outlive the account it belongs to');
    assert.ok(stats.every((record) => record.synthetic === true));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a reflection and its file survive a reload together', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Movement' });
  try {
    await waitForNote(page, 'Movement');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'reload@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Walked at lunch and wrote it down.');
    await dialog.locator('input[type="file"]').setInputFiles([
      { name: 'walk.png', mimeType: 'image/png', buffer: TINY_PNG },
    ]);
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.reload();
    const body = await goToView(page, 'account');
    await body.locator('.demo-row').waitFor();
    assert.match(await body.textContent(), /Walked at lunch and wrote it down\./);
    await body.locator('.demo-evidence-image').waitFor();
    assert.equal(await body.locator('.demo-evidence-image').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the activity control never appears in a preview or in the Markdown', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Activities' });
  try {
    await waitForNote(page, 'Activities');
    assert.equal(await page.locator('button.demo-log-activity').count(), 0);

    // Hovering the link to an activity note previews the note, not the control.
    const link = lastPane(page).locator('a[data-note-id="Breath"]').first();
    await link.hover();
    await page.locator('#preview:not([hidden])').waitFor();
    await page.locator('#preview-content .note-content, #preview-content').first().waitFor();
    assert.equal(await page.locator('#preview button.demo-log-activity').count(), 0);
    assert.equal(await page.locator('#preview').getAttribute('aria-hidden'), 'true');

    // An embedded activity previews its static prompt, never a field or a form.
    await lastPane(page).locator('a[data-note-id="Orientation"]').first().hover();
    await page.waitForFunction(() =>
      /what led you to open this guide/.test(document.querySelector('#preview-content')?.textContent ?? ''));
    assert.equal(await page.locator('#preview .inline-activity').count(), 1);
    assert.match(await page.locator('#preview .inline-activity-prompt').textContent(), /what led you to open this guide/);
    assert.equal(await page.locator('#preview .inline-activity-form').count(), 0);
    assert.equal(await page.locator('#preview textarea, #preview .inline-activity-save, #preview .inline-activity-login').count(), 0);

    // And the published source of the notes has no trace of either control.
    const notes = JSON.parse(await readFile(join(repoRoot, 'dist', 'notes.json'), 'utf8'));
    assert.doesNotMatch(notes.notes.Breath.html, /log-activity|Log activity/);
    assert.equal(notes.notes.Breath.activity, true);
    assert.match(notes.notes.Orientation.html, /class="inline-activity"/);
    assert.doesNotMatch(notes.notes.Orientation.html, /<form|<textarea|<button|log-activity/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------ inline activities --- */

/** The one inline activity the vault currently embeds, in the newest pane. */
const inlineActivity = (page) => lastPane(page).locator('.inline-activity');

/** Wait for the reader to hydrate the embedded activity's form. */
async function waitForInlineForm(page) {
  const block = inlineActivity(page);
  await block.locator('.inline-activity-form').waitFor();
  return block;
}

/* ------------------------------------------- mocked-store session races --- */

/**
 * Mount an isolated copy of the demo UI over a deterministic fake store.
 *
 * The session/merge races below are hard to time through the real reader and a
 * real database, so the harness appends its own `article` with a single
 * embedded activity to the home page and leaves the real app untouched. Every
 * store call that needs to be held open is exposed as a gate on
 * `window.__mock.gates`, so a test can block it and release it without sleeping.
 * `window.__mount()` rebuilds the UI over the same `window.__mock` state, which
 * simulates a reload: the stored rows and the claimed localStorage entries
 * persist while the UI does not.
 *
 * These are mocked-store tests. The local demo workflows around them keep
 * exercising the real IndexedDB store and never use this harness.
 */
async function mountMockedInline(page, { session = null, rows = [], guests = [] } = {}) {
  await page.evaluate(async ({ session, rows }) => {
    const { createDemoUi } = await import(new URL('./demo-ui.js', location.href).href);

    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };

    const state = {
      session,
      rows: rows.map((row) => ({ evidence: [], ...row })),
      creates: [],
      listCalls: 0,
      readSessionCalls: 0,
      changeCount: 0,
      gates: {},
    };
    window.__mock = state;
    window.__setGate = (name) => { state.gates[name] = deferred(); };
    window.__releaseGate = (name, value) => {
      const gate = state.gates[name];
      delete state.gates[name];
      gate.resolve(value);
    };

    window.__mount = () => {
      document.querySelector('[data-test-inline]')?.remove();
      const article = document.createElement('article');
      article.className = 'note-content';
      article.dataset.testInline = '';
      article.innerHTML = '<section class="inline-activity" '
        + 'data-activity-title="What brought you here?" data-activity-id="what-brought-you-here">'
        + '<h2 class="inline-activity-title" id="what-brought-you-here">What brought you here?</h2>'
        + '<div class="inline-activity-prompt">Why did you open this guide?</div></section>';
      document.body.append(article);

      const store = {
        remote: false,
        disclosure: 'Deterministic test store.',
        async open() {},
        async seedIfNeeded() { return { seeded: false }; },
        async readSession() {
          state.readSessionCalls += 1;
          return state.gates.readSession ? state.gates.readSession.promise : state.session;
        },
        async writeSession(accountId) { state.session = accountId ? state.session : null; },
        async listSubmissions({ accountId } = {}) {
          state.listCalls += 1;
          if (state.gates.listSubmissions) return state.gates.listSubmissions.promise;
          return state.rows.filter((row) => !accountId || row.accountId === accountId);
        },
        async createSubmission(input) {
          state.creates.push({ ...input });
          if (state.gates.createSubmission) await state.gates.createSubmission.promise;
          const submission = {
            id: `mock-submission-${state.rows.length + 1}`,
            status: 'pending',
            pinned: false,
            createdAt: '2026-11-22T10:00:00.000Z',
            evidence: [],
            ...input,
          };
          state.rows.push(submission);
          return { submission, evidence: [] };
        },
        async listEvidence() { return []; },
        async listReviewEvents() { return []; },
        async getStats(accountId) { return { accountId, pages: {}, activeMs: 0 }; },
        async listAccounts() { return []; },
        async listStats() { return []; },
        async resetAll() { state.rows = []; },
        async signIn(email) { return { account: { id: `account-${email}`, email }, created: true }; },
        async sendCode() { return { sent: false }; },
        async reviewSubmission() {},
        async setPin() {},
      };

      const ui = createDemoUi({ store });
      ui.onChange(() => { state.changeCount += 1; });
      ui.decorateArticle(article, { id: 'Orientation', title: 'Orientation' });
      window.__ui = ui;
      window.__article = article;
      return true;
    };
  }, { session, rows });

  await page.evaluate((entries) => {
    localStorage.setItem('vitruvian.guest-activities', JSON.stringify(entries));
  }, guests);
  await page.evaluate(() => window.__mount());
}

for (const prefix of ['/', `${config.projectPath.replace(/\/$/, '')}/`]) {
  test(`inline save links to history and returns the exact reading place under ${prefix}`, { skip: !playwright }, async () => {
    const { context, page, errors } = await openPage({
      reading: 'stacked', reducedMotion: 'reduce', viewport: { width: 900, height: 360 },
      url: `${prefix}?note=Breath&stackedNotes=Orientation#what-brought-you-here`,
    });
    try {
      await waitForNote(page, 'Orientation');
      const block = await waitForInlineForm(page);
      await block.locator('textarea').fill('Synthetic opening reflection.');
      await block.getByRole('button', { name: 'Save response' }).click();
      const link = block.locator('a.activity-log-link');
      await link.waitFor();
      assert.equal(await link.textContent(), 'View activity log');
      assert.equal(await link.getAttribute('data-account-view'), 'account');
      assert.equal(await link.getAttribute('data-account-section'), 'activity-history');
      const readingUrl = page.url();
      const destination = new URL(await link.getAttribute('href'), readingUrl);
      const reading = new URL(readingUrl);
      assert.equal(destination.pathname, reading.pathname);
      assert.equal(destination.hash, reading.hash);
      assert.equal(destination.searchParams.get('note'), 'Breath');
      assert.deepEqual(destination.searchParams.getAll('stackedNotes'), ['Orientation']);
      assert.equal(destination.searchParams.get('view'), 'account');
      assert.equal(destination.searchParams.get('section'), 'activity-history');
      // Clicking an offscreen link scrolls the sheet before navigation captures
      // it, so measure the reading place with the actual link already in view.
      await link.scrollIntoViewIfNeeded();
      const sheet = lastPane(page).locator('.pane-sheet');
      const scroll = await sheet.evaluate(async (node) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return node.scrollTop;
      });
      assert.ok(scroll > 0, 'fragment opens a scrolled reading position');
      await link.click();
      await waitForAccountView(page);
      await assertCollection(page, 1, { subject: 'general', format: 'reflection' });
      assert.deepEqual(await accountBody(page).locator('#activity-history .activity-tag').allTextContents(), ['General', 'Reflection']);
      assert.match(await accountBody(page).locator('#activity-history').textContent(), /Synthetic opening reflection\./);
      await page.waitForFunction(() => document.activeElement === document.querySelector('#activity-history h2'));
      const heading = await accountBody(page).locator('#activity-history h2').boundingBox();
      const region = await accountRegion(page).boundingBox();
      assert.ok(heading.y >= region.y && heading.y < region.y + region.height, 'history is scrolled into view');
      const logUrl = page.url();
      await page.goBack();
      await page.waitForURL(readingUrl);
      await waitForNote(page, 'Orientation');
      const backScroll = await sheet.evaluate(async (node) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return node.scrollTop;
      });
      await page.goForward();
      await waitForAccountView(page);
      assert.equal(page.url(), logUrl);
      await page.locator('#account-back').click();
      await page.waitForURL(readingUrl);
      await waitForNote(page, 'Orientation');
      const returnedScroll = await sheet.evaluate(async (node) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return node.scrollTop;
      });
      await page.goBack();
      await waitForAccountView(page);
      assert.equal(page.url(), logUrl);
      await assertCollection(page, 1);
      await page.reload();
      await waitForAccountView(page);
      assert.equal(page.url(), logUrl);
      await assertCollection(page, 1);
      // Ordinary href navigation in a new tab, not the app's click handler.
      const direct = await context.newPage();
      await direct.goto(destination.href);
      await waitForAccountView(direct);
      await assertCollection(direct, 1);
      await direct.reload();
      await waitForAccountView(direct);
      await direct.locator('#account-back').click();
      await direct.waitForURL(readingUrl);
      await waitForNote(direct, 'Orientation');
      assert.equal(await accountRegion(direct).isVisible(), false);
      await direct.close();
      assert.deepEqual(errors, []);
      assert.deepEqual({ returnScroll: returnedScroll, backScroll }, { returnScroll: scroll, backScroll: scroll },
        'Return and Back must preserve the reader scroll, not re-anchor the retained hash');
    } finally { await context.close(); }
  });
}

test('User outline paints while runtime config is pending and a stale load cannot replace Settings', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    let requested = false;
    await page.route('**/supabase-config.json', async (route) => {
      requested = true;
      await gate;
      await route.fulfill({ json: { mode: 'local' } });
    });
    await page.goto('/?note=Orientation&view=account', { waitUntil: 'domcontentloaded' });
    await assertUserSkeleton(page);
    assert.equal(requested, true);
    await page.locator('#account [data-account-view="settings"]').click();
    release();
    await waitForAccountView(page, 'settings');
    await page.locator('#account-content #demo-appearance').waitFor();
    assert.equal(await accountBody(page).locator('.demo-row, .activity-collection').count(), 0);
    await page.locator('#account [data-account-view="account"]').click();
    await waitForAccountView(page);
    await assertCollection(page, 0);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('User outline waits for database init but Settings does not', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    url: '/?note=Orientation&view=account',
    initScript: () => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const request = open.apply(this, args);
        request.addEventListener('success', (event) => {
          event.stopImmediatePropagation();
          window.__releaseDatabase = () => request.onsuccess?.call(request, event);
        }, { once: true });
        return request;
      };
    },
  });
  try {
    await assertUserSkeleton(page);
    await page.waitForFunction(() => typeof window.__releaseDatabase === 'function');
    await page.locator('#account [data-account-view="settings"]').click();
    await waitForAccountView(page, 'settings');
    await page.locator('#account-content #demo-appearance').selectOption('dark');
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    await page.evaluate(() => window.__releaseDatabase());
    await page.locator('#account [data-account-view="account"]').click();
    await waitForAccountView(page);
    await assertCollection(page, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('public portfolio and scholarship are genuinely disabled for guests and signed-in readers', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    const requests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || /public|share|scholar|portfolio|apply/i.test(url.pathname)) requests.push(request.url());
    });
    for (const signedIn of [false, true]) {
      if (signedIn) await signInFromAccount(page, 'disabled-actions@example.com');
      else await goToView(page);
      const scholarship = accountBody(page).locator('[data-account-section="scholarship"]');
      assert.equal(await scholarship.locator('h2').textContent(), 'Vitruvian scholarship');
      assert.equal(await scholarship.getByRole('button', { name: 'Learn more' }).isDisabled(), true);
      assert.equal(await scholarship.getByRole('button', { name: 'Learn more' }).getAttribute('aria-disabled'), 'true');
      assert.match(await scholarship.textContent(), /Coming soon/);
      assert.equal(await scholarship.locator('a, button:enabled, input, form').count(), 0);
      // Native DOM activation of a disabled button must not run an action.
      await scholarship.locator('button').evaluate((node) => node.click());
      await goToView(page, 'settings');
      const portfolio = accountBody(page).locator('[data-account-section="portfolio"]');
      assert.match(await portfolio.textContent(), /Public portfolio.*Private.*Make public.*Coming soon/s);
      assert.equal(await portfolio.getByRole('button', { name: 'Make public' }).isDisabled(), true);
      assert.equal(await portfolio.getByRole('button', { name: 'Make public' }).getAttribute('aria-disabled'), 'true');
      assert.equal(await portfolio.locator('a, button:enabled, input, form').count(), 0);
      const url = page.url();
      await portfolio.locator('button').evaluate((node) => node.click());
      assert.equal(page.url(), url);
      assert.equal(context.pages().length, 1);
    }
    assert.deepEqual(requests, [], 'no sharing, application or external network actions');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile dark collection caps at 160 pebbles with exact accessible counts and no idle animation', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    url: '/?note=Orientation&view=account', viewport: config.mobileViewport,
    reducedMotion: 'reduce', colorScheme: 'dark',
    initScript: () => {
      localStorage.setItem('vitruvian.appearance', 'dark');
      // Synthetic read fixture deliberately exceeds the normal guest write cap.
      localStorage.setItem('vitruvian.guest-activities', JSON.stringify(Array.from({ length: 173 }, (_, index) => ({
        id: `synthetic-${index}`, noteId: 'Movement', noteTitle: 'Synthetic movement',
        reflection: `Test reflection ${index}`, at: '2026-01-01T12:00:00.000Z',
      }))));
      const request = window.requestAnimationFrame.bind(window);
      window.__frameRequests = 0;
      window.requestAnimationFrame = (callback) => { window.__frameRequests += 1; return request(callback); };
    },
  });
  try {
    await waitForAccountView(page);
    const collection = await assertCollection(page, 173, { subject: 'physical', format: 'practice' });
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    assert.equal(await collection.locator('.activity-collection-more').textContent(), '+13 more');
    assert.equal(await collection.locator('.activity-collection-svg').getAttribute('aria-hidden'), 'true');
    assert.equal(await collection.locator('.activity-collection-count').getAttribute('aria-hidden'), null);
    assert.equal(await accountBody(page).locator('#activity-history .demo-row').count(), 173);
    const text = await collection.ariaSnapshot();
    assert.match(text, /173 activities/);
    assert.match(text, /\+13 more/);
    assert.match(text, /Physical/);
    const bounds = await collection.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= config.mobileViewport.width);
    assert.equal(await collection.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await accountRegion(page).evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    const geometry = () => collection.locator('.activity-collection-svg path').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('d'), node.getAttribute('transform')]));
    const first = await geometry();
    assert.equal(first.length, 160);
    assert.ok(first.every(([path, transform]) => path.startsWith('M ') && /translate\(.+\) scale\(/.test(transform)));
    // Let all reader layout work settle, then observe an idle window. Counting
    // requested frames detects loops even if they keep writing the same geometry.
    await page.waitForTimeout(150);
    const frames = await page.evaluate(() => window.__frameRequests);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__frameRequests), frames);
    assert.deepEqual(await geometry(), first);

    // A remount may reuse the same visible prefix, but its overflow count must
    // come from the current records, not the cached pile.
    await page.evaluate(() => {
      const key = 'vitruvian.guest-activities';
      const entries = JSON.parse(localStorage.getItem(key));
      entries.push({ ...entries[0], id: 'zz-overflow-174', reflection: 'One more synthetic activity.' });
      localStorage.setItem(key, JSON.stringify(entries));
    });
    await goToView(page, 'settings');
    await goToView(page);
    await assertCollection(page, 174, { subject: 'physical', format: 'practice' });
    assert.equal(await collection.locator('.activity-collection-more').textContent(), '+14 more');
    assert.deepEqual(await geometry(), first, 'an offscreen addition does not rearrange the visible pile');

    await page.reload();
    await waitForAccountView(page);
    await assertCollection(page, 173);
    assert.deepEqual(await geometry(), first, 'reduced-motion settled geometry survives reload');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('an embedded activity answers in place: validation, guest save, reload and upsert', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    const block = await waitForInlineForm(page);

    // One section, with the static prompt, and none of the legacy dialog flow.
    assert.equal(await page.locator('.stack > .pane .inline-activity').count(), 1);
    assert.equal(await page.locator('button.demo-log-activity').count(), 0, 'no legacy log control');
    assert.equal(await page.locator('dialog.demo-dialog-activity').count(), 0, 'no dialog');
    assert.equal((await block.locator('h2.inline-activity-title').textContent()).trim(), 'What brought you here?');
    assert.equal(await block.locator('h2.inline-activity-title').getAttribute('id'), 'what-brought-you-here');
    assert.match(await block.locator('.inline-activity-prompt').textContent(), /what led you to open this guide/);
    assert.equal((await block.locator('label').textContent()).trim(), 'Your response');
    assert.equal(await block.locator('.inline-activity-login').isVisible(), false, 'no log-in nudge before a response exists');

    // Empty: refused next to the field, with the field marked invalid.
    await block.getByRole('button', { name: 'Save response' }).click();
    await block.locator('.demo-error:visible').waitFor();
    assert.match(await block.locator('.demo-error:visible').textContent(), /Add a short reflection/);
    assert.equal(await block.locator('textarea').getAttribute('aria-invalid'), 'true');

    // A guest answer is stored in this browser, in place.
    await block.locator('textarea').fill('  I want to understand my money better.  ');
    await block.getByRole('button', { name: 'Save response' }).click();
    await block.locator('.inline-activity-status').filter({ hasText: 'Saved on this device' }).waitFor();
    assert.equal(await block.locator('.inline-activity-login').isVisible(), true);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].reflection, 'I want to understand my money better.');
    assert.equal(stored[0].noteId, 'Orientation#what-brought-you-here');
    assert.equal(stored[0].noteTitle, 'What brought you here?');
    const firstId = stored[0].id;

    // Reload: the saved answer comes back, still exactly one entry.
    await page.reload();
    await waitForNote(page, 'Orientation');
    const reloaded = await waitForInlineForm(page);
    assert.equal(await reloaded.locator('textarea').inputValue(), 'I want to understand my money better.');
    assert.equal((await reloaded.locator('.inline-activity-status').textContent()).trim(), 'Saved on this device.');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')))).length, 1);

    // Editing and saving again updates that entry instead of appending one.
    await reloaded.locator('textarea').fill('');
    assert.equal(await reloaded.locator('textarea').inputValue(), '', 'editing must not restore the old response');
    assert.equal((await reloaded.locator('.inline-activity-status').textContent()).trim(), 'Unsaved changes.');
    await reloaded.locator('textarea').fill('A different answer.');
    assert.equal((await reloaded.locator('.inline-activity-status').textContent()).trim(), 'Unsaved changes.');
    await reloaded.getByRole('button', { name: 'Save response' }).click();
    await page.waitForFunction(() => {
      const entries = JSON.parse(localStorage.getItem('vitruvian.guest-activities') ?? '[]');
      return entries.length === 1 && entries[0].reflection === 'A different answer.';
    });
    const updated = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(updated.length, 1, 'an edit must not duplicate the entry');
    assert.equal(updated[0].id, firstId, 'an edit keeps the stored id');
    assert.equal(await page.locator('.stack > .pane .inline-activity-form').count(), 1, 'one form, not two');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an embedded activity keeps its text when storage is blocked, and still saves without IndexedDB', { skip: !playwright }, async () => {
  // 1. localStorage refuses the guest key: the reader says so and keeps the text.
  const blocked = await openPage({
    url: '/?note=Orientation',
    initScript: () => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(key, value) {
        if (key === 'vitruvian.guest-activities') throw new DOMException('blocked', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    },
  });
  try {
    await waitForNote(blocked.page, 'Orientation');
    const block = await waitForInlineForm(blocked.page);
    await block.locator('textarea').fill('Keep this text.');
    await block.getByRole('button', { name: 'Save response' }).click();
    await block.locator('.demo-error:visible').waitFor();
    assert.match(await block.locator('.demo-error:visible').textContent(), /would not store the response/);
    assert.equal(await block.locator('textarea').inputValue(), 'Keep this text.', 'refused storage must not lose the input');
    assert.equal(await blocked.page.evaluate(() => localStorage.getItem('vitruvian.guest-activities')), null);
    // The notes are unaffected.
    await blocked.page.click('#app-title');
    await waitForNote(blocked.page);
    assert.deepEqual(blocked.errors, []);
  } finally {
    await blocked.context.close();
  }

  // 2. No IndexedDB at all: the account store is unavailable, but a local
  //    response needs only localStorage and still works.
  const missing = await openPage({
    url: '/?note=Orientation',
    initScript: () => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    },
  });
  try {
    await waitForNote(missing.page, 'Orientation');
    const block = await waitForInlineForm(missing.page);
    await block.locator('textarea').fill('Saved without a database.');
    await block.getByRole('button', { name: 'Save response' }).click();
    await block.locator('.inline-activity-status').filter({ hasText: 'Saved on this device' }).waitFor();
    const stored = await missing.page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].reflection, 'Saved without a database.');
    await block.locator('a.activity-log-link').click();
    await waitForAccountView(missing.page);
    await assertCollection(missing.page, 1, { subject: 'general', format: 'reflection' });
    assert.match(await accountBody(missing.page).locator('#activity-history').textContent(), /Saved without a database\./);
    assert.equal(await missing.page.evaluate(() => document.activeElement?.textContent), 'Activity history');
    await missing.page.reload();
    await waitForAccountView(missing.page);
    await assertCollection(missing.page, 1);
    assert.deepEqual(missing.errors, []);
  } finally {
    await missing.context.close();
  }
});

test('an embedded guest response merges into the account once, and resaving adds nothing', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    const block = await waitForInlineForm(page);
    await block.locator('textarea').fill('What brought me here is a question about money.');
    await block.getByRole('button', { name: 'Save response' }).click();
    await block.locator('.inline-activity-status').filter({ hasText: 'Saved on this device' }).waitFor();

    // The inline control offers the sign-in that keeps it in a portfolio.
    await block.locator('.inline-activity-login').click();
    const dialog = page.locator('dialog.demo-dialog-signin');
    await dialog.waitFor();
    await completeSignIn(dialog, 'inline@example.com');
    await dialog.waitFor({ state: 'detached' });

    // The browser entry moved into the account, exactly once.
    await page.waitForFunction(() => localStorage.getItem('vitruvian.guest-activities') === '[]');
    const refreshed = await waitForInlineForm(page);
    assert.equal((await refreshed.locator('.inline-activity-save').textContent()).trim(), 'Save for review');
    assert.match(await refreshed.locator('.inline-activity-privacy').textContent(), /visible to reviewers/);
    await page.waitForFunction(() =>
      /Pending review/.test(document.querySelector('.inline-activity-status')?.textContent ?? ''));
    assert.equal((await submissionsFor(page, 'inline@example.com')).length, 1);

    // Re-saving the unchanged response must not create a second submission.
    await refreshed.locator('.inline-activity-save').click();
    await page.waitForFunction(() => {
      const save = document.querySelector('.inline-activity-save');
      const status = document.querySelector('.inline-activity-status');
      return Boolean(save) && !save.disabled && !/Saving/.test(status?.textContent ?? '');
    });
    assert.equal((await submissionsFor(page, 'inline@example.com')).length, 1, 'an unchanged resave must be idempotent');

    const body = await goToView(page, 'account');
    await body.locator('.demo-row').waitFor();
    assert.equal(await body.locator('.demo-row').count(), 1);
    assert.match(await body.textContent(), /What brought me here is a question about money\./);
    await assertCollection(page, 1, { subject: 'general', format: 'reflection' });
    assert.deepEqual(await body.locator('#activity-history .activity-tag').allTextContents(), ['General', 'Reflection']);
    await body.getByRole('button', { name: /^Pin the/ }).click();
    await body.locator('.demo-gallery-card').waitFor();
    await assertCollection(page, 1, { subject: 'general', format: 'reflection' });
    await page.reload();
    await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'general', format: 'reflection' });
    assert.equal(await body.locator('#activity-history .demo-row').count(), 1);
    assert.equal(await body.locator('.demo-gallery-card').count(), 1);
    assert.equal((await submissionsFor(page, 'inline@example.com')).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a signed-in embedded save reaches User, states reviewer access, and clears on sign out', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    const body = await signInFromAccount(page, 'inline-signed@example.com');
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await waitForNote(page, 'Orientation');

    const block = await waitForInlineForm(page);
    assert.equal((await block.locator('.inline-activity-save').textContent()).trim(), 'Save for review');
    assert.match(await block.locator('.inline-activity-privacy').textContent(), /visible to reviewers/);
    assert.equal(await block.locator('.inline-activity-login').isVisible(), false);

    await block.locator('textarea').fill('Saved while signed in.');
    await block.locator('.inline-activity-save').click();
    await page.waitForFunction(() =>
      /Pending review/.test(document.querySelector('.inline-activity-status')?.textContent ?? ''));

    // The post-save link reaches the actual account history.
    await block.locator('a.activity-log-link').click();
    await waitForAccountView(page);
    await assertCollection(page, 1, { subject: 'general', format: 'reflection' });
    await body.locator('.demo-row').waitFor();
    assert.equal(await body.locator('.demo-row').count(), 1);
    assert.match(await body.locator('.demo-status').first().textContent(), /Pending/);
    assert.match(await body.textContent(), /Saved while signed in\./);

    // Signing out clears the account's words from the reader's field.
    await body.getByRole('button', { name: 'Sign out' }).click();
    await body.locator('.demo-signin').waitFor();
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await waitForNote(page, 'Orientation');
    await page.waitForFunction(() => document.querySelector('.inline-activity textarea')?.value === '');
    const after = await waitForInlineForm(page);
    assert.equal(await after.locator('textarea').inputValue(), '');
    assert.equal((await after.locator('.inline-activity-save').textContent()).trim(), 'Save response');
    assert.match(await after.locator('.inline-activity-privacy').textContent(), /only in this browser/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a delayed restored session refuses a browser-only save until the reader submits again', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    await mountMockedInline(page, {
      session: { id: 'account-a', email: 'a@example.com' },
      rows: [],
      guests: [],
    });
    const block = page.locator('[data-test-inline] .inline-activity');
    await block.locator('.inline-activity-form').waitFor();
    assert.equal((await block.locator('.inline-activity-save').textContent()).trim(), 'Save response');

    // Hold the initial session restore open, then submit while the control still
    // believes the reader is signed out.
    await page.evaluate(() => window.__setGate('readSession'));
    await block.locator('textarea').fill('A browser-only answer.');
    await block.locator('.inline-activity-save').click();
    await page.waitForFunction(() => window.__mock.readSessionCalls === 1);

    // The save is blocked on init and has written nothing yet.
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 0);
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 0);

    // The session restores now. The save must refuse, explain itself, and show
    // the account's privacy line, without writing to the account.
    await page.evaluate(() => window.__releaseGate('readSession', { id: 'account-a', email: 'a@example.com' }));
    await block.locator('.demo-error:visible').waitFor();
    assert.match(await block.locator('.demo-error:visible').textContent(), /sign-in changed/i);
    assert.equal((await block.locator('.inline-activity-save').textContent()).trim(), 'Save for review');
    assert.match(await block.locator('.inline-activity-privacy').textContent(), /visible to reviewers/);
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 0, 'a browser-only save makes no account write');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 0);
    assert.equal(await block.locator('textarea').inputValue(), 'A browser-only answer.',
      'the words are kept for the second submit');

    // An explicit second submit, now that the account is known, writes once.
    await block.locator('.inline-activity-save').click();
    await block.locator('.inline-activity-status').filter({ hasText: 'Pending review' }).waitFor();
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1);
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1);
    assert.equal(await page.evaluate(() => window.__mock.rows[0].reflection), 'A browser-only answer.');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a restored guest import racing an inline save still leaves one submission', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    await mountMockedInline(page, {
      session: { id: 'account-a', email: 'a@example.com' },
      rows: [],
      guests: [{
        id: 'guest-1',
        noteId: 'Orientation#what-brought-you-here',
        noteTitle: 'What brought you here?',
        reflection: 'Why I am here.',
        at: '2026-11-22T10:00:00.000Z',
      }],
    });
    const block = page.locator('[data-test-inline] .inline-activity');
    await block.locator('.inline-activity-form').waitFor();

    // Hold the restored import's first read open, then let the reader save the
    // same words while the import is still in flight.
    await page.evaluate(() => window.__setGate('listSubmissions'));
    await page.evaluate(() => { window.__initPromise = window.__ui.init(); });
    await page.waitForFunction(() => window.__mock.listCalls === 1);
    await block.locator('textarea').fill('Why I am here.');
    await block.locator('.inline-activity-save').click();
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 0, 'the save waits for the import');

    // Release the import: it writes the row, and the racing save settles on it.
    await page.evaluate(() => window.__releaseGate('listSubmissions', []));
    await block.locator('.inline-activity-status').filter({ hasText: 'Pending review' }).waitFor();
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1, 'the race creates one row, not two');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')).length), 0,
      'the imported entry left the browser');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a failed local cleanup retries without duplicating and never imports into another account', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    // The account write succeeds; the follow-up localStorage cleanup is refused,
    // so the bound entry has to stay behind for a retry.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(key, value) {
        if (key === 'vitruvian.guest-activities' && JSON.parse(value).length === 0) {
          throw new DOMException('blocked', 'QuotaExceededError');
        }
        return original.call(this, key, value);
      };
    });

    await mountMockedInline(page, {
      session: { id: 'account-a', email: 'a@example.com' },
      rows: [],
      guests: [{
        id: 'guest-1',
        noteId: 'Orientation#what-brought-you-here',
        noteTitle: 'What brought you here?',
        reflection: 'Bound to account A.',
        at: '2026-11-22T10:00:00.000Z',
      }],
    });
    await page.evaluate(() => window.__setGate('createSubmission'));
    await page.evaluate(() => { window.__initPromise = window.__ui.init(); });
    await page.waitForFunction(() => window.__mock.creates.length === 1);
    await page.evaluate(() => window.__releaseGate('createSubmission'));
    await page.waitForFunction(() => window.__mock.changeCount === 1);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored.length, 1, 'the cleanup failure keeps the entry');
    assert.equal(stored[0].accountId, 'account-a', 'the entry stays bound to the account that wrote it');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1);
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1);

    // Recreate the UI over the same state: a reload. The same account must
    // recover the earlier write instead of importing the entry a second time.
    await page.evaluate(() => window.__mount());
    await page.evaluate(() => window.__ui.init());
    await page.waitForFunction(() => window.__mock.changeCount === 2);
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1, 'the retry does not duplicate the row');
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1);

    // Another account cannot import an entry bound to the first.
    await page.evaluate(() => { window.__mock.session = { id: 'account-b', email: 'b@example.com' }; });
    await page.evaluate(() => window.__mount());
    await page.evaluate(() => window.__ui.init());
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1, 'account B imports nothing');
    assert.equal(
      await page.evaluate(() => window.__mock.rows.filter((row) => row.accountId === 'account-b').length),
      0,
    );
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(after[0].accountId, 'account-a', 'the bound entry still belongs to account A');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a manual account save claims a browser response before writing, and cleans up only on a match', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    await mountMockedInline(page, {
      session: { id: 'account-a', email: 'a@example.com' },
      rows: [],
      guests: [{
        id: 'guest-1',
        noteId: 'Orientation#what-brought-you-here',
        noteTitle: 'What brought you here?',
        reflection: 'Why I am here.',
        at: '2026-11-22T10:00:00.000Z',
      }],
    });
    const block = page.locator('[data-test-inline] .inline-activity');
    await block.locator('.inline-activity-form').waitFor();

    // Storage refuses the guest key, so the restored session's automatic import
    // cannot bind the entry. Nothing may reach the account.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.__restoreGuestStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function patchedSetItem(key, value) {
        if (key === 'vitruvian.guest-activities') throw new DOMException('blocked', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.evaluate(() => { window.__initPromise = window.__ui.init(); });
    await page.waitForFunction(() => window.__mock.changeCount === 1);
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 0, 'a refused import writes no row');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 0);
    let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].accountId, undefined, 'the refused import leaves the entry anonymous');
    assert.equal((await block.locator('.inline-activity-save').textContent()).trim(), 'Save for review');

    // The reader edits the response and saves it to the account. The typed text
    // differs from the browser-saved one, but the claim still applies first, and
    // its refusal must stop the account write and keep the words.
    await block.locator('textarea').fill('A revised answer.');
    await block.locator('.inline-activity-save').click();
    await block.locator('.demo-error:visible').waitFor();
    assert.match(await block.locator('.demo-error:visible').textContent(), /could not prepare/);
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 0, 'a refused claim makes no account write');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 0);
    assert.equal(await block.locator('textarea').inputValue(), 'A revised answer.', 'the words are kept for the retry');
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored[0].accountId, undefined, 'the refused claim leaves the entry anonymous');

    // Permit writes, then save again: the claim must be bound before the row is
    // sent, and the mismatched local copy must survive the successful write.
    await page.evaluate(() => window.__restoreGuestStorage());
    await page.evaluate(() => window.__setGate('createSubmission'));
    await block.locator('.inline-activity-save').click();
    await page.waitForFunction(() => window.__mock.creates.length === 1);
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored[0].accountId, 'account-a', 'the entry is bound before the account write');
    assert.equal(stored[0].reflection, 'Why I am here.', 'binding does not rewrite the browser-saved response');
    await page.evaluate(() => window.__releaseGate('createSubmission'));
    await block.locator('.inline-activity-status').filter({ hasText: 'Pending review' }).waitFor();
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1);
    assert.equal(await page.evaluate(() => window.__mock.rows[0].reflection), 'A revised answer.');
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored.length, 1, 'a mismatched response keeps the local copy');
    assert.equal(stored[0].accountId, 'account-a');

    // A second anonymous copy whose text matches what the account already holds
    // is removed after the save, and adds no duplicate row.
    await page.evaluate(() => {
      const entries = JSON.parse(localStorage.getItem('vitruvian.guest-activities'));
      entries.push({
        id: 'guest-2',
        noteId: 'Orientation#what-brought-you-here',
        noteTitle: 'What brought you here?',
        reflection: 'A revised answer.',
        at: '2026-11-22T10:05:00.000Z',
      });
      localStorage.setItem('vitruvian.guest-activities', JSON.stringify(entries));
    });
    await block.locator('textarea').fill('A revised answer.');
    await block.locator('.inline-activity-save').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')).length === 1);
    assert.equal(await page.evaluate(() => window.__mock.creates.length), 1, 'a matching save reuses the stored row');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), 1);
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored[0].id, 'guest-1', 'only the matching anonymous copy is removed');
    assert.equal(stored[0].accountId, 'account-a');

    // A later account cannot inherit the entry bound to account A, even when the
    // harness recreates the UI over the same browser storage.
    const before = await page.evaluate(() => ({
      creates: window.__mock.creates.length,
      rows: window.__mock.rows.length,
      listCalls: window.__mock.listCalls,
    }));
    await page.evaluate(() => { window.__mock.session = { id: 'account-b', email: 'b@example.com' }; });
    await page.evaluate(() => window.__mount());
    await page.evaluate(() => window.__ui.init());
    assert.equal(await page.evaluate(() => window.__mock.creates.length), before.creates, 'account B imports nothing');
    assert.equal(await page.evaluate(() => window.__mock.rows.length), before.rows);
    assert.equal(await page.evaluate(() => window.__mock.listCalls), before.listCalls,
      'account B does not even read submissions for an A-bound entry');
    assert.equal(
      await page.evaluate(() => window.__mock.rows.filter((row) => row.accountId === 'account-b').length),
      0,
    );
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vitruvian.guest-activities')));
    assert.equal(stored[0].accountId, 'account-a', 'the entry still belongs to account A');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an unchanged account save after a reload stays one submission', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    const body = await signInFromAccount(page, 'reload-inline@example.com');
    await page.locator('#account-back').click();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('view'));
    await waitForNote(page, 'Orientation');

    const first = await waitForInlineForm(page);
    await page.waitForFunction(() =>
      document.querySelector('.inline-activity-save')?.textContent.trim() === 'Save for review');
    await first.locator('textarea').fill('Kept across a reload.');
    await first.locator('.inline-activity-save').click();
    await page.waitForFunction(() =>
      /Pending review/.test(document.querySelector('.inline-activity-status')?.textContent ?? ''));
    assert.equal((await submissionsFor(page, 'reload-inline@example.com')).length, 1);

    await page.reload();
    await waitForNote(page, 'Orientation');
    const second = await waitForInlineForm(page);
    await page.waitForFunction(() =>
      document.querySelector('.inline-activity-save')?.textContent.trim() === 'Save for review');
    await second.locator('textarea').fill('Kept across a reload.');
    await second.locator('.inline-activity-save').click();
    await page.waitForFunction(() =>
      /Pending review/.test(document.querySelector('.inline-activity-status')?.textContent ?? ''));
    assert.equal((await submissionsFor(page, 'reload-inline@example.com')).length, 1,
      'an unchanged save after reload must not add a second submission');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the home activity link opens Orientation at its heading, and subjects show display titles', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ reading: 'stacked', viewport: { width: 1100, height: 420 } });
  try {
    await waitForNote(page, 'Vitruvian');
    const home = lastPane(page);
    const activity = home.locator('a[data-note-id="Orientation"][data-heading="what-brought-you-here"]');
    assert.equal(await activity.count(), 1);
    assert.equal((await activity.textContent()).trim(), 'What brought you here?');
    await activity.click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    await waitForNote(page, 'Orientation');

    const orientation = lastPane(page);
    const heading = orientation.locator('#what-brought-you-here');
    await heading.waitFor();
    assert.equal(await heading.evaluate((element) => element.tagName), 'H2');
    assert.equal((await heading.textContent()).trim(), 'What brought you here?');
    assert.equal(await heading.locator('xpath=ancestor::section[contains(@class, "inline-activity")]').count(), 1);
    // The anchor really brought the activity into view.
    await page.waitForFunction(() => {
      const pane = document.querySelector('.stack > .pane:last-child');
      const sheet = pane?.querySelector('.pane-sheet');
      const target = pane?.querySelector('#what-brought-you-here');
      if (!sheet || !target) return false;
      const offset = target.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
      return offset > -40 && offset < 140;
    });

    // Orientation's body links only to the home page.
    const bodyLinks = orientation.locator('.note-content p a[data-note-id]');
    assert.deepEqual(await bodyLinks.evaluateAll((nodes) => nodes.map((node) => node.dataset.noteId)), ['Base Note']);

    // A subject keeps its id but shows its H1 title.
    await page.goto('/?note=Base Note');
    await waitForNote(page, 'Vitruvian');
    const aliases = await lastPane(page).locator('.note-content a[data-note-id]').evaluateAll((nodes) =>
      nodes.map((node) => [node.dataset.noteId, node.textContent.trim()]));
    assert.ok(aliases.some(([id, label]) => id === 'Intillectual' && label === 'Intellectual'));
    assert.ok(aliases.some(([id, label]) => id === 'financial wellness' && label === 'Financial wellness'));
    assert.ok(aliases.some(([id, label]) => id === 'social skills' && label === 'Social skills'));
    await lastPane(page).locator('a[data-note-id="Intillectual"]').click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    await waitForNote(page, 'Intellectual');
    assert.equal(await lastPane(page).getAttribute('data-note-id'), 'Intillectual');
    assert.equal((await lastPane(page).locator('.note-content h1').textContent()).trim(), 'Intellectual');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the header title goes home, not to Orientation', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Movement' });
  try {
    await waitForNote(page, 'Movement');
    assert.equal(await page.locator('#app-title').getAttribute('title'), 'Home');
    await page.click('#app-title');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('note') === 'Base Note');
    await waitForNote(page, 'Vitruvian');
    assert.equal(await lastPane(page).getAttribute('data-note-id'), 'Base Note');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the embedded activity form fits a phone and stays usable', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    reading: 'stacked', viewport: config.mobileViewport, reducedMotion: 'reduce', url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    const form = inlineActivity(page).locator('.inline-activity-form');
    await form.waitFor();

    for (const width of [430, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `the inline activity does not overflow at ${width}px`,
      );
      for (const [name, box] of [
        ['title', await inlineActivity(page).locator('.inline-activity-title').boundingBox()],
        ['response', await form.locator('textarea').boundingBox()],
        ['save', await form.locator('.inline-activity-save').boundingBox()],
      ]) {
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `the ${name} control fits at ${width}px`);
      }
    }

    // The form is still usable at the phone width.
    await page.setViewportSize(config.mobileViewport);
    await form.locator('textarea').fill('Typed on a phone.');
    await form.locator('.inline-activity-save').click();
    await inlineActivity(page).locator('.inline-activity-status').filter({ hasText: 'Saved on this device' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------ reader regressions --- */

test('breadcrumbs show the curated path and can be turned off', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Movement' });
  try {
    await waitForNote(page, 'Movement');
    const crumbs = lastPane(page).locator('.breadcrumbs');
    await crumbs.waitFor();
    assert.deepEqual(await crumbs.locator('.breadcrumb-link').allTextContents(), ['Vitruvian', 'Physical wellness']);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.breadcrumbs), 'on');

    await crumbs.locator('a[data-note-id="Physical wellness"]').click();
    await waitForNote(page, 'Physical wellness');
    assert.deepEqual(await lastPane(page).locator('.breadcrumb-link').allTextContents(), ['Vitruvian']);

    await goToView(page, 'settings');
    await page.locator('#demo-breadcrumbs').uncheck();
    await page.locator('#account-back').click();
    await waitForNote(page);
    assert.equal(await lastPane(page).locator('.breadcrumbs').isVisible(), false);
    await page.reload();
    await waitForNote(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.breadcrumbs), 'off');
    assert.equal(await lastPane(page).locator('.breadcrumbs').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('page mode follows ordinary links, with browser Back as the path', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page, 'Vitruvian');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.reading), 'page');
    assert.equal(await paneCount(page), 1);
    assert.equal(await page.locator('.pane-spine').isVisible(), false);
    assert.equal(await page.locator('.pane-close').count(), 0);

    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('note') === 'Physical wellness');
    await waitForNote(page, 'Physical wellness');
    assert.equal(await paneCount(page), 1);
    assert.equal(new URL(page.url()).searchParams.has('stackedNotes'), false);

    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('note') === 'Base Note');
    await waitForNote(page, 'Vitruvian');
    assert.equal(await paneCount(page), 1);

    // The advanced layout is a preference, and switching back closes the row.
    await goToView(page, 'settings');
    await page.locator('#demo-reading-mode').selectOption('stacked');
    await page.waitForFunction(() => document.documentElement.dataset.reading === 'stacked');
    await page.locator('#account-back').click();
    await waitForNote(page);
    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.stack > .pane').length === 2);
    await page.locator('#settings-button').click();
    await page.locator('#account-back').click();
    await waitForNote(page);
    await goToView(page, 'settings');
    await page.locator('#demo-reading-mode').selectOption('page');
    await page.waitForFunction(() => document.documentElement.dataset.reading === 'page');
    await page.locator('#account-back').click();
    await page.waitForFunction(() => document.querySelectorAll('.stack > .pane').length === 1);
    await waitForNote(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('stacked navigation, Back/Forward, scroll restoration and previews still work', { skip: !playwright }, async () => {
  // The vault notes are short, so a short window is what makes a pane scrollable.
  const { context, page, errors } = await openPage({
    reading: 'stacked', viewport: { width: 1280, height: 300 }, url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    assert.equal(await paneCount(page), 1);

    const firstSheet = page.locator('.stack > .pane').first().locator('.pane-sheet');
    const offset = await firstSheet.evaluate((element) => {
      element.scrollTo(0, 10_000);
      return element.scrollTop;
    });
    assert.ok(offset > 20, 'the first pane must be scrollable for this test');

    await lastPane(page).locator('a[data-note-id="Base Note"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.equal(await paneCount(page), 2);
    assert.match(page.url(), /note=Orientation&stackedNotes=Base(%20|\+)Note/);

    await page.goBack();
    await page.locator('.stack > .pane').nth(1).waitFor({ state: 'detached' });
    assert.equal(await paneCount(page), 1);
    await page.goForward();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.equal(await paneCount(page), 2);

    // Closing the covering pane rebuilds the row; the reader's place comes back.
    await page.locator('.pane-close').last().click();
    await page.locator('.stack > .pane').nth(1).waitFor({ state: 'detached' });
    await page.waitForFunction((expected) => {
      const top = document.querySelector('.stack > .pane .pane-sheet')?.scrollTop ?? -1;
      return Math.abs(top - expected) <= 2;
    }, offset);

    // Hover previews still need a window tall enough for the card. Orientation
    // links only to the home page now, so the preview path runs through that.
    // Return the pane to the top first: Playwright's own scroll would race the
    // preview, which dismisses itself on any scroll.
    await page.setViewportSize(config.viewport);
    await firstSheet.evaluate((element) => element.scrollTo({ top: 0 }));
    await page.waitForFunction(() => (document.querySelector('.stack > .pane .pane-sheet')?.scrollTop ?? -1) === 0);
    await lastPane(page).locator('a.note-link[data-note-id="Base Note"]').first().hover();
    await page.waitForFunction(() => /looking after yourself/.test(document.querySelector('#preview-content')?.textContent ?? ''));
    assert.ok((await page.locator('#preview-content a[data-note-id]').count()) >= 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('search, backlinks and the subpath build still work', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({
    reading: 'stacked', url: `${config.projectPath}/` });
  try {
    // GitHub Pages project path: the default note loads, and the reader keeps
    // writing its own relative URLs under the prefix.
    await waitForNote(page);
    assert.match(page.url(), /\/vitruvian\/\?note=Base(%20|\+)Note/);

    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.match(page.url(), /\/vitruvian\/\?note=Base(%20|\+)Note&stackedNotes=Physical(%20|\+)wellness/);

    // Backlinks are collapsed by default; open the disclosure, then read cards.
    await lastPane(page).locator('.backlinks-summary').click();
    await lastPane(page).locator('.backlink-card').first().waitFor();
    assert.ok((await lastPane(page).locator('.backlink-card').count()) >= 1);

    // Search opens a result in a new pane, from the prefix.
    await page.locator('#search-input').fill('breath');
    await page.locator('.search-result').first().waitFor();
    await page.locator('.search-result').first().click();
    await page.locator('.stack > .pane').nth(2).waitFor();

    // Reload keeps the whole stack, still under the prefix.
    const stacked = page.url();
    await page.reload();
    await page.locator('.stack > .pane').nth(2).waitFor();
    assert.equal(page.url(), stacked);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the mobile layout keeps the header and both regions usable', { skip: !playwright }, async () => {
  // Reduced motion turns the search field's width transition off, so each
  // breakpoint can be measured the moment the viewport changes.
  const { context, page, errors } = await openPage({
    reading: 'stacked', viewport: config.mobileViewport, reducedMotion: 'reduce' });
  try {
    await waitForNote(page);
    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();

    assert.equal(await page.locator('.stack > .pane').first().isVisible(), false);
    assert.equal(await lastPane(page).isVisible(), true);

    // Every existing mobile breakpoint, plus the two edges around them.
    for (const width of [800, 700, 560, 430, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const button = await page.locator('#settings-button').boundingBox();
      assert.ok(button.x >= 0 && button.x + button.width <= width + 0.5, `the User info control fits at ${width}px`);
      const search = await page.locator('#search-input').boundingBox();
      assert.ok(search.width >= 30, `the search field is usable at ${width}px`);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `the header does not overflow at ${width}px`,
      );
    }
    await page.setViewportSize(config.mobileViewport);

    // The account region fits this width, and its own navigation stays usable.
    const body = await goToView(page, 'account');
    await body.locator('.demo-signin').waitFor();
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `the account region does not overflow at ${width}px`,
      );
      const back = await page.locator('#account-back').boundingBox();
      assert.ok(back.x >= 0 && back.x + back.width <= width + 0.5, `Return to notes fits at ${width}px`);
    }
    await page.setViewportSize(config.mobileViewport);

    // Settings is usable at this width too, and the demo still works.
    const settings = await goToView(page, 'settings');
    const select = await settings.locator('#demo-appearance').boundingBox();
    assert.ok(select.width > 60 && select.x + select.width <= config.mobileViewport.width + 0.5);

    await goToView(page, 'account');
    await completeSignIn(body, 'phone@example.com');
    await body.locator('.demo-facts').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
