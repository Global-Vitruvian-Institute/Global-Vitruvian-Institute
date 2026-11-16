/**
 * Configuration for the browser workflow tests.
 *
 * These tests drive the built site (`dist/`) in a real browser. They are not
 * part of `npm test`: they need Playwright and a browser, so they live behind
 * `npm run test:browser` and skip themselves with a clear message when either is
 * missing.
 *
 * Playwright is resolved in this order:
 *   1. `PLAYWRIGHT_MODULE` — an explicit path to `playwright/index.mjs`;
 *   2. `playwright` in this project's own `node_modules`;
 *   3. a sibling project's `node_modules/playwright` (the local development
 *      setup this repository is usually tested from).
 *
 * A local Chrome channel is used by default, so no browser download is needed.
 * Set `DEMO_CHANNEL=bundled` to use Playwright's own Chromium instead.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export const config = {
  /** A separate port from the README preview (4182) so both can run at once. */
  port: Number(process.env.DEMO_PORT ?? 4183),
  /** The same server also answers under this prefix, standing in for GitHub Pages. */
  projectPath: '/vitruvian',
  viewport: { width: 1280, height: 900 },
  mobileViewport: { width: 390, height: 844 },
  headless: process.env.DEMO_HEADED !== '1',
  channel: process.env.DEMO_CHANNEL === 'bundled' ? null : (process.env.DEMO_CHANNEL ?? 'chrome'),
  /** Skipped unless `DEMO_SKIP_BUILD=1`, so the tests always see current source. */
  skipBuild: process.env.DEMO_SKIP_BUILD === '1',
};

function playwrightCandidates() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(resolve(process.env.PLAYWRIGHT_MODULE));
  candidates.push(join(repoRoot, 'node_modules', 'playwright', 'index.mjs'));

  const parent = dirname(repoRoot);
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(join(parent, entry.name, 'node_modules', 'playwright', 'index.mjs'));
    }
  } catch {
    /* the parent directory is not readable; the other candidates still apply */
  }
  return candidates;
}

/** Load the Playwright library, or return null when it is not installed. */
export async function resolvePlaywright() {
  for (const candidate of playwrightCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      /* try the next candidate */
    }
  }
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

export function baseUrlFor(page = '') {
  return `http://127.0.0.1:${config.port}${page}`;
}
