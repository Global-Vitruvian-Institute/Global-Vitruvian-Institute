/**
 * Browser workflows for the local participation demo, plus the reader
 * regressions the demo must not break.
 *
 *   npm run test:browser
 *
 * The suite builds `dist/`, serves it over HTTP (also under a project prefix, to
 * stand in for GitHub Pages), and drives it with Playwright. Each test gets a
 * fresh browser context, so every test starts with an empty IndexedDB.
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
async function openPage({ viewport = config.viewport, url = '/', initScript = null, reducedMotion = null } = {}) {
  const context = await browser.newContext({
    viewport,
    baseURL: baseUrlFor(),
    hasTouch: false,
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  if (initScript) await context.addInitScript(initScript);
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

const lastPane = (page) => page.locator('.stack > .pane').last();

async function waitForNote(page, title = null) {
  await page.waitForFunction((expected) => {
    const pane = document.querySelector('.stack > .pane:last-child');
    if (!pane) return false;
    const content = pane.querySelector('.note-content');
    if (!content || content.hasAttribute('aria-busy') || content.childElementCount === 0) return false;
    return expected ? (pane.getAttribute('aria-label') || '') === expected : true;
  }, title);
}

/** The account pane and the sign-in dialog share one form; this fills either. */
async function completeSignIn(scope, email) {
  await scope.locator('input[type="email"]').fill(email);
  await scope.getByRole('button', { name: 'Continue' }).click();
  await scope.locator('.demo-code-value').waitFor();
  await scope.locator('input[type="text"]').fill(DEMO_VERIFICATION_CODE);
  await scope.getByRole('button', { name: 'Sign in' }).click();
}

async function signInFromAccountPane(page, email) {
  await page.click('#user-info-button');
  const pane = lastPane(page);
  await pane.locator('.demo-signin').waitFor();
  await completeSignIn(pane, email);
  await pane.locator('.demo-facts').waitFor();
  return pane;
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

/* ------------------------------------------------------------------ tests --- */

test('sign in with the on-screen code; the account view states the demo limits', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('h1.demo-title').waitFor();
    assert.equal((await pane.locator('h1.demo-title').textContent()).trim(), 'User info');
    // The view is a reserved pane id in the ordinary URL, not a Markdown note.
    assert.equal(await pane.getAttribute('aria-label'), 'User info');
    assert.match(page.url(), /(?:note|stackedNotes)=demo%3Aaccount/);
    assert.match(await pane.textContent(), /Insecure local-only demo/);
    assert.match(await pane.textContent(), /no server, no real authentication and no email/);

    await pane.locator('input[type="email"]').fill('not-an-email');
    await pane.getByRole('button', { name: 'Continue' }).click();
    assert.match(await pane.locator('.demo-error:visible').textContent(), /does not look like an email/);

    await pane.locator('input[type="email"]').fill('Ada@Example.com');
    await pane.getByRole('button', { name: 'Continue' }).click();
    // The code is on screen because there is no email delivery.
    assert.equal((await pane.locator('.demo-code-value').textContent()).trim(), DEMO_VERIFICATION_CODE);

    await pane.locator('input[type="text"]').fill('000000');
    await pane.getByRole('button', { name: 'Sign in' }).click();
    assert.match(await pane.locator('.demo-error:visible').textContent(), /does not match/);

    await pane.locator('input[type="text"]').fill(DEMO_VERIFICATION_CODE);
    await pane.getByRole('button', { name: 'Sign in' }).click();
    await pane.locator('.demo-facts').waitFor();

    assert.match(await pane.textContent(), /Signed in as ada@example\.com/);
    assert.match(await pane.textContent(), /Local estimate, measured in this browser only/);
    // Short empty states, and no promotional calls to action.
    assert.match(await pane.textContent(), /Nothing pinned yet\./);
    assert.match(await pane.textContent(), /No activity logged yet\./);
    assert.equal(await pane.locator('a.demo-evidence-download').count(), 0);

    // The admin page is not a global navigation item.
    assert.equal(await page.locator('header button', { hasText: 'Admin' }).count(), 0);
    assert.equal(await pane.getByRole('button', { name: 'Admin page' }).count(), 0);

    // The account pane closes and comes back through history like any other.
    await page.locator('.pane-close').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.stack > .pane').length === 1);
    await page.goBack();
    await lastPane(page).locator('h1.demo-title').waitFor();
    assert.match(page.url(), /(?:note|stackedNotes)=demo%3Aaccount/);
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

    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-row').waitFor();
    assert.equal(await pane.locator('.demo-row').count(), 1);
    assert.equal((await pane.locator('.demo-status').first().textContent()).trim(), 'Pending');
    assert.match(await pane.textContent(), /Two slow breaths before the first meeting\./);
    assert.match(await pane.textContent(), /No review yet\./);

    // A note without `activity: true` never grows the control.
    await page.goto('/?note=Base Note');
    await waitForNote(page);
    assert.equal(await page.locator('button.demo-log-activity').count(), 0);
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

    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-evidence-image').waitFor();

    const preview = pane.locator('.demo-evidence-image');
    assert.match(await preview.getAttribute('src'), /^blob:/);
    assert.equal(await pane.locator('.demo-evidence').count(), 1);

    const download = pane.locator('a.demo-evidence-download');
    assert.equal(await download.count(), 1);
    assert.match(await download.textContent(), /Download payload\.html/);
    assert.equal(await download.getAttribute('download'), 'payload.html');
    assert.match(await download.getAttribute('href'), /^blob:/);
    assert.equal(await pane.locator('iframe').count(), 0, 'evidence is never framed');
    assert.equal(await page.evaluate(() => window.__pwned ?? null), null, 'uploaded markup never ran');

    // Leaving the pane revokes the object URLs it created, so they cannot be
    // reused after the evidence is off screen.
    const previewSrc = await preview.getAttribute('src');
    await page.click('#app-title');
    await waitForNote(page);
    const revoked = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, previewSrc);
    assert.equal(revoked, true, 'the evidence object URL must be revoked with its pane');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the admin page reviews seeded participants and keeps a history', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage();
  try {
    await waitForNote(page);
    const pane = await signInFromAccountPane(page, 'admin@vitruvian.demo');
    // The demo admin is an ordinary local account, and only it sees the link.
    assert.match(await pane.textContent(), /Local account in this browser/);
    await pane.getByRole('button', { name: 'Admin page' }).click();

    const admin = lastPane(page);
    await admin.locator('h1.demo-title').waitFor();
    assert.equal((await admin.locator('h1.demo-title').textContent()).trim(), 'Admin');
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
  const { context, page, errors } = await openPage({ url: '/?note=Reflection' });
  try {
    await waitForNote(page, 'Reflection');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'owner@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Wrote three lines at the end of the day.');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.click('#user-info-button');
    let pane = lastPane(page);
    await pane.locator('.demo-row').waitFor();
    assert.equal(await pane.locator('.demo-gallery-card').count(), 0);

    // Pin it, whatever its review status.
    const pin = pane.getByRole('button', { name: /^Pin the/ });
    await pin.click();
    await pane.locator('.demo-gallery-card').waitFor();
    assert.equal(await pane.locator('.demo-gallery-card').count(), 1);
    assert.match(await pane.locator('.demo-gallery-card').textContent(), /Wrote three lines/);
    // The pinned item is still in the history.
    assert.equal(await pane.locator('.demo-row').count(), 1);

    await page.reload();
    await page.click('#user-info-button');
    pane = lastPane(page);
    await pane.locator('.demo-gallery-card').waitFor();
    assert.match(await pane.textContent(), /Signed in as owner@example\.com/);
    assert.equal(await pane.locator('.demo-gallery-card').count(), 1);
    assert.equal((await pane.locator('.demo-fact-value').nth(1).textContent()).trim(), '1');

    // Account switching: another address sees nothing of the first account.
    await pane.getByRole('button', { name: 'Sign out' }).click();
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'someone-else@example.com');
    await pane.locator('.demo-facts').waitFor();
    assert.match(await pane.textContent(), /Signed in as someone-else@example\.com/);
    assert.match(await pane.textContent(), /Nothing pinned yet\./);
    assert.match(await pane.textContent(), /No activity logged yet\./);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('clearing local data asks for confirmation and restores the fixtures', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Reflection' });
  try {
    await waitForNote(page, 'Reflection');
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'temp@example.com');
    const activity = page.locator('dialog.demo-dialog-activity');
    await activity.waitFor();
    await activity.locator('textarea').fill('Temporary.');
    await activity.getByRole('button', { name: 'Save as pending' }).click();
    await activity.waitFor({ state: 'detached' });

    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.getByRole('button', { name: 'Clear local demo data' }).click();
    const confirm = page.locator('dialog.demo-dialog-confirm');
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await pane.locator('.demo-row').count(), 1, 'cancel keeps the data');

    await pane.getByRole('button', { name: 'Clear local demo data' }).click();
    await page.locator('dialog.demo-dialog-confirm').getByRole('button', { name: 'Clear local data' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor({ state: 'detached' });
    // Clearing also ends the local session, so the sign-in form comes back.
    await pane.locator('.demo-signin').waitFor();
    assert.match(await page.locator('#status').textContent(), /Local demo data cleared/);
    assert.match(await page.locator('#status').textContent(), /Synthetic fixtures restored/);
    // The account really is gone: signing in again starts from nothing.
    await completeSignIn(pane, 'temp@example.com');
    await pane.locator('.demo-facts').waitFor();
    assert.match(await pane.textContent(), /No activity logged yet\./);
    assert.match(await pane.textContent(), /Nothing pinned yet\./);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('dialogs take focus, keep it, dismiss on Escape, and block reader shortcuts', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Reflection' });
  try {
    await waitForNote(page, 'Reflection');
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
    assert.equal(await page.evaluate(() => document.activeElement?.className ?? ''), 'demo-button demo-log-activity');

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
    await missing.page.click('#user-info-button');
    const pane = lastPane(missing.page);
    await pane.locator('.demo-failure').waitFor();
    assert.match(await pane.textContent(), /User info is unavailable/);
    assert.match(await pane.textContent(), /The notes themselves are unaffected\./);
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
    await page.click('#user-info-button');
    let pane = lastPane(page);
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'measured@example.com');
    await pane.locator('.demo-facts').waitFor();
    assert.equal((await pane.locator('.demo-fact-value').nth(1).textContent()).trim(), '0');

    // Two distinct notes, opened the way a reader would.
    await page.click('#app-title');
    await waitForNote(page);
    await page.locator('#search-input').fill('Movement');
    await page.locator('.search-result').first().click();
    await waitForNote(page, 'Movement');
    // Let the view write land before the account pane reads the statistics.
    await page.waitForTimeout(200);

    // A preview is not a page, and neither is a demo pane.
    await page.click('#user-info-button');
    pane = lastPane(page);
    await pane.locator('.demo-facts').waitFor();
    assert.equal((await pane.locator('.demo-fact-value').nth(1).textContent()).trim(), '2');
    assert.match(await pane.locator('.demo-fact-value').first().textContent(), /^\d+[smh]/);
    assert.match(await pane.textContent(), /Local estimate, measured in this browser only/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('on a phone, User info brings an open account pane back in front of Admin', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ viewport: config.mobileViewport, url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'admin@vitruvian.demo');
    await pane.locator('.demo-facts').waitFor();
    await pane.getByRole('button', { name: 'Admin page' }).click();

    // Admin is rightmost, so on this width the account pane is open but hidden.
    await lastPane(page).locator('h1.demo-title').waitFor();
    assert.equal((await lastPane(page).locator('h1.demo-title').textContent()).trim(), 'Admin');
    assert.equal(await page.locator('.stack > .pane').count(), 3);

    // The header entry brings User info back in front through the stack URL.
    await page.click('#user-info-button');
    await lastPane(page).locator('h1.demo-title').waitFor();
    assert.equal((await lastPane(page).locator('h1.demo-title').textContent()).trim(), 'User info');
    assert.match(page.url(), /stackedNotes=demo%3Aaccount$/);
    assert.equal(await page.locator('.stack > .pane').count(), 3);

    // Back and Forward still describe the order that was on screen.
    await page.goBack();
    await page.waitForFunction(() =>
      document.querySelector('.stack > .pane:last-child h1.demo-title')?.textContent.trim() === 'Admin');
    await page.goForward();
    await page.waitForFunction(() =>
      document.querySelector('.stack > .pane:last-child h1.demo-title')?.textContent.trim() === 'User info');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('clearing local data discards pending reading time and leaves no orphan statistics', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    await page.click('#user-info-button');
    let pane = lastPane(page);
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'orphan@example.com');
    await pane.locator('.demo-facts').waitFor();

    // Read a real note for a few seconds: below the 20s flush threshold.
    await page.click('#app-title');
    await waitForNote(page);
    await page.waitForTimeout(3_000);

    // Clear everything, including that unflushed stretch.
    await page.click('#user-info-button');
    pane = lastPane(page);
    await pane.locator('.demo-facts').waitFor();
    await pane.getByRole('button', { name: 'Clear local demo data' }).click();
    await page.locator('dialog.demo-dialog-confirm').getByRole('button', { name: 'Clear local data' }).click();
    await page.locator('dialog.demo-dialog-confirm').waitFor({ state: 'detached' });
    await page.waitForTimeout(600);

    const stored = await page.evaluate(async () => {
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

    assert.equal(stored.accounts.some((account) => account.email === 'orphan@example.com'), false);
    const accountIds = new Set(stored.accounts.map((account) => account.id));
    assert.ok(stored.stats.every((record) => accountIds.has(record.accountId)),
      'no statistics row may outlive the account it belongs to');
    assert.ok(stored.stats.every((record) => record.synthetic === true));
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
    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-row').waitFor();
    assert.match(await pane.textContent(), /Walked at lunch and wrote it down\./);
    await pane.locator('.demo-evidence-image').waitFor();
    assert.equal(await pane.locator('.demo-evidence-image').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('an admin review reaches the participant’s pinned portfolio and history', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Reflection' });
  try {
    await waitForNote(page, 'Reflection');
    // The participant logs and pins a submission.
    await page.locator('button.demo-log-activity').click();
    await page.locator('dialog.demo-dialog-signin').waitFor();
    await completeSignIn(page.locator('dialog.demo-dialog-signin'), 'reviewed@example.com');
    const dialog = page.locator('dialog.demo-dialog-activity');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Wrote three lines at the end of the day.');
    await dialog.getByRole('button', { name: 'Save as pending' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.click('#user-info-button');
    let pane = lastPane(page);
    await pane.locator('.demo-row').waitFor();
    await pane.getByRole('button', { name: /^Pin the/ }).click();
    await pane.locator('.demo-gallery-card').waitFor();
    assert.match(await pane.locator('.demo-gallery-card .demo-status').textContent(), /Pending/);

    // The demo admin verifies it.
    await pane.getByRole('button', { name: 'Sign out' }).click();
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'admin@vitruvian.demo');
    await pane.locator('.demo-facts').waitFor();
    await pane.getByRole('button', { name: 'Admin page' }).click();
    const admin = lastPane(page);
    await admin.locator('h1.demo-title').waitFor();
    const submissions = admin.locator('.demo-section').nth(1);
    const row = submissions.locator('.demo-row').filter({ hasText: 'reviewed@example.com' }).first();
    await row.locator('.demo-status').filter({ hasText: 'Pending' }).waitFor();
    await row.locator('select').selectOption('verified');
    await row.getByRole('button', { name: 'Save review' }).click();
    await row.locator('.demo-status').filter({ hasText: 'Verified' }).waitFor();

    // Close Admin and sign back in as the participant.
    await page.locator('.pane-close').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.stack > .pane').length === 2);
    pane = lastPane(page);
    await pane.getByRole('button', { name: 'Sign out' }).click();
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'reviewed@example.com');

    // The pinned card and the history row agree with the review.
    await pane.locator('.demo-gallery-card').waitFor();
    assert.match(await pane.locator('.demo-gallery-card .demo-status').textContent(), /Verified/);
    assert.equal((await pane.locator('.demo-row .demo-status').first().textContent()).trim(), 'Verified');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a slow account load cannot overwrite a newer one', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: '/?note=Breath' });
  try {
    await waitForNote(page, 'Breath');
    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'race@example.com');
    await pane.locator('.demo-facts').waitFor();

    // Hold the first submissions read of the account pane open, so one refresh
    // is still in flight when the next one has already committed.
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

    // First entry: starts the slow refresh.
    await page.locator('button.demo-log-activity').click();
    const first = page.locator('dialog.demo-dialog-activity');
    await first.waitFor();
    await first.locator('textarea').fill('First entry.');
    await first.getByRole('button', { name: 'Save as pending' }).click();
    await first.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__delayedRead === true);

    // Second entry: a newer refresh finishes first.
    await page.locator('button.demo-log-activity').click();
    const second = page.locator('dialog.demo-dialog-activity');
    await second.waitFor();
    await second.locator('textarea').fill('Second entry.');
    await second.getByRole('button', { name: 'Save as pending' }).click();
    await second.waitFor({ state: 'detached' });

    await pane.locator('.demo-row').filter({ hasText: 'Second entry.' }).waitFor();
    // The delayed older load resolves now; it must not replace the newer view.
    await page.waitForTimeout(1_600);
    assert.match(await pane.textContent(), /First entry\./);
    assert.match(await pane.textContent(), /Second entry\./);
    assert.equal(await pane.locator('.demo-row').count(), 2);
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

    // And the published source of the note has no trace of it.
    const notes = JSON.parse(await readFile(join(repoRoot, 'dist', 'notes.json'), 'utf8'));
    assert.doesNotMatch(notes.notes.Breath.html, /log-activity|Log activity/);
    assert.equal(notes.notes.Breath.activity, true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------ reader regressions --- */

test('stacked navigation, Back/Forward, scroll restoration and previews still work', { skip: !playwright }, async () => {
  // The vault notes are short, so a short window is what makes a pane scrollable.
  const { context, page, errors } = await openPage({ viewport: { width: 1280, height: 300 }, url: '/?note=Orientation' });
  try {
    await waitForNote(page, 'Orientation');
    assert.equal(await page.locator('.stack > .pane').count(), 1);

    const firstSheet = page.locator('.stack > .pane').first().locator('.pane-sheet');
    const offset = await firstSheet.evaluate((element) => {
      element.scrollTo(0, 10_000);
      return element.scrollTop;
    });
    assert.ok(offset > 20, 'the first pane must be scrollable for this test');

    await lastPane(page).locator('a[data-note-id="Base Note"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.equal(await page.locator('.stack > .pane').count(), 2);
    assert.match(page.url(), /note=Orientation&stackedNotes=Base(%20|\+)Note/);

    await page.goBack();
    await page.locator('.stack > .pane').nth(1).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.stack > .pane').count(), 1);
    await page.goForward();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.equal(await page.locator('.stack > .pane').count(), 2);

    // Closing the covering pane rebuilds the row; the reader's place comes back.
    await page.locator('.pane-close').last().click();
    await page.locator('.stack > .pane').nth(1).waitFor({ state: 'detached' });
    await page.waitForFunction((expected) => {
      const top = document.querySelector('.stack > .pane .pane-sheet')?.scrollTop ?? -1;
      return Math.abs(top - expected) <= 2;
    }, offset);

    // Hover previews still need a window tall enough for the card.
    await page.setViewportSize(config.viewport);
    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().hover();
    await page.locator('#preview:not([hidden])').waitFor();
    assert.match(await page.locator('#preview-content').textContent(), /listen to your body/);
    assert.ok((await page.locator('#preview-content a[data-note-id]').count()) >= 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('search, backlinks and the subpath build still work', { skip: !playwright }, async () => {
  const { context, page, errors } = await openPage({ url: `${config.projectPath}/` });
  try {
    // GitHub Pages project path: the default note loads, and the reader keeps
    // writing its own relative URLs under the prefix.
    await waitForNote(page);
    assert.match(page.url(), /\/vitruvian\/\?note=Base(%20|\+)Note/);

    await lastPane(page).locator('a[data-note-id="Physical wellness"]').first().click();
    await page.locator('.stack > .pane').nth(1).waitFor();
    assert.match(page.url(), /\/vitruvian\/\?note=Base(%20|\+)Note&stackedNotes=Physical(%20|\+)wellness/);

    // Backlinks render as cards.
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

test('the mobile layout keeps the header usable and shows one pane', { skip: !playwright }, async () => {
  // Reduced motion turns the search field's width transition off, so each
  // breakpoint can be measured the moment the viewport changes.
  const { context, page, errors } = await openPage({ viewport: config.mobileViewport, reducedMotion: 'reduce' });
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
      const button = await page.locator('#user-info-button').boundingBox();
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

    // The demo works at this width too.
    await page.click('#user-info-button');
    const pane = lastPane(page);
    await pane.locator('.demo-signin').waitFor();
    await completeSignIn(pane, 'phone@example.com');
    await pane.locator('.demo-facts').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
