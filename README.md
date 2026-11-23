# Vitruvian Institute

A static reader for the Markdown in `vault/`. Edit notes in Obsidian; Markdown is the source of truth.

Notes open one page at a time by default: wikilinks are ordinary links, and browser Back is the reading path. **Settings → Reading** offers stacked tabs as an advanced mode, where earlier notes stay open to the left. Search, backlinks, hover previews, and full-page User info / Settings / Admin are available in both modes.

**Settings → Appearance** chooses a stylesheet template. The Clear, Paper, and Soft Lilac templates are local. Minimal, Things, and Blue Topaz only adapt colour tokens from MIT-licensed Obsidian themes; sources are cited in `reader/public/themes/`. No theme layout or component CSS is copied.

A small **browser-only participation demo** sits on top of the reader: notes marked `activity: true` gain a *Log activity* control, and a **User info** entry in the header opens a local account page with a pinned portfolio, an activity history and an admin review page. It is a modest illustration of how participating *might* work later — not a product, and not a substitute for the guide. The Markdown guide is the primary content and its notes are still being authored. There is no server, no real authentication and no email — see [Local participation demo](#local-participation-demo).

## Local preview

Requires Node.js 22+ and Python 3 for this preview command.

```sh
npm ci
npm test
npm run build
python3 -m http.server 4182 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4182/. Rebuild after editing notes. The home page is `vault/Base Note.md`. URLs use `?note=…&stackedNotes=…`, so links and reloads work on static hosting, including GitHub Pages project subpaths.

## Account pages and appearance

The account views are a **separate full page**, not a pane in the reading stack:

```text
?note=Breath&stackedNotes=Movement                the reader
?note=Breath&stackedNotes=Movement&view=account   User info
?note=Breath&stackedNotes=Movement&view=settings  Settings
?note=Breath&stackedNotes=Movement&view=admin     Admin (authorized accounts only)
```

**Return to notes** removes only `view`, so the reading stack, its horizontal position and every note's scroll offset come back exactly as they were. Reload, browser Back/Forward and direct links all reproduce the same page, and `?view=…` works under a project subpath because it is an ordinary query parameter. User info stays in the header; Settings and the authorized Admin entry live in the account page's own small navigation row. Header **Random** and **Search** still work from any account page — choosing a note returns to the reader.

**Settings** offers three built-in light appearances, with no account and no dependency:

- **Clear** (default) — white surfaces, charcoal text and blue links.
- **Paper** — warm off-white surfaces with the same blue links.
- **Soft Lilac** — neutral light surfaces with restrained violet accents.

They change colour tokens only: layout, typography and behaviour are identical, and there is no dark or automatic mode. The choice is stored in this browser's `localStorage` (one key, `vitruvian.appearance`) and applied before first paint; if the browser refuses storage, the preset still applies for the visit and the page says so.

## Tests

```sh
npm test           # vault, build, static reader, routes, appearance, demo domain, store and tracking
npm run test:browser   # real-browser workflows and reader regressions
```

`npm test` runs on Node alone. The browser suite builds `dist/`, serves it over HTTP (also under a `/vitruvian/` prefix, standing in for GitHub Pages) and drives it with Playwright; each test gets a fresh browser profile, so every run starts from an empty IndexedDB.

Playwright is resolved from `PLAYWRIGHT_MODULE`, from this project's `node_modules`, or from a sibling project's `node_modules`. It uses the installed Google Chrome (`DEMO_CHANNEL=bundled` for Playwright's own Chromium, `DEMO_HEADED=1` to watch it). Without Playwright the browser suite skips itself with a message instead of failing.

## Publish

In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**. Pushes to `main` build and deploy `dist/` using `.github/workflows/pages.yml`.

Only generated reader files and rendered notes are deployed. Obsidian settings, dependencies, archives and local environment files are ignored by Git. **Treat every tracked Markdown note as public:** the reader excludes private-tagged notes from its output, but that does not hide files committed to a public repository.

## Local participation demo

Everything below runs in the reader's own page. It exists to show what participating would feel like while the guide content is being authored; it is not a prototype of a service, and it is deliberately modest rather than a second product experience. The activity notes in `vault/` are placeholders for human-written guidance: the demo records what a reader logs and adds no advice of its own.

**It is deliberately insecure.** There is no server, no API, no real authentication and no email. Accounts, submissions, uploaded evidence and reading statistics live in this browser's IndexedDB for this origin, and may be lost or cleared at any time. Anyone with access to this browser profile can read them, and the demo admin page is designed to inspect every account stored here. Nothing is sent anywhere; nothing syncs between devices or browsers.

### Signing in

1. Open **User info** in the top right.
2. Enter any email address (for example `you@example.com`) and choose *Continue*.
3. Type the demo verification code that is printed on screen: **`482913`**.

There is no password and no verification email; the code is displayed precisely because there is no delivery step. An address that has not been seen before creates a new local account. `admin@vitruvian.demo` additionally reveals an *Admin* entry in the account page's own navigation — the admin view is never a global navigation item.

### Activities, portfolio and review

- A note whose frontmatter says `activity: true` shows one small *Log activity* control after its content. The control never appears in hover previews or in the Markdown source. The activity notes in `vault/` (`Breath`, `Movement`, `Reflection`, `Money check-in`) already carry the flag; `scripts/build.mjs` publishes only that boolean and no other frontmatter.
- A submission needs a trimmed reflection, a file, or both. New submissions are saved as **pending**.
- **User info** shows a pinned portfolio gallery, then the complete activity history. Any of your own submissions can be pinned or unpinned whatever its review status, and pinned items remain in the history too.
- The admin page lists the seeded synthetic participants and any local accounts created in this browser, with per-account pages explored, active time and submissions. Reviews move a submission between **pending**, **verified** and **changes requested**, requesting changes requires feedback, and every review is kept as a timestamped history event.

### Evidence files

- At most **3 files**, **2 MB each**, **4 MB in total**, per submission.
- PNG, JPEG, GIF, WebP and AVIF preview inside the page. Everything else — including PDF, text, HTML and SVG — is offered as a download whose bytes are served as `application/octet-stream`, so an uploaded file can never be rendered as markup in this origin.
- Evidence is stored as raw bytes in IndexedDB alongside its submission, in one transaction: a failed write leaves nothing half-saved. When the account page goes away its preview URLs are revoked.
- If the browser refuses storage or runs out of room, the reader says so in the dialog and keeps everything you typed; it never falls back to `localStorage`.

### Reading statistics

Active time and distinct pages are measured only for the signed-in reader, only for notes that actually rendered from the vault, and only while the tab is visible, the reader is not idle, no demo dialog is open and the reader is actually showing. Hover previews, failed loads, account pages and pane rebuilds are not pages. Measured figures are labelled *local estimates*; the seeded participants' figures are labelled *synthetic*.

### Clearing local data

**User info → Clear local demo data** asks for confirmation, then removes every local account, submission, uploaded file and reading statistic for this origin and restores the synthetic fixtures. Clearing browser storage for the site has the same effect.

## Production

See [docs/production-plan.md](docs/production-plan.md) for the environment plan and [docs/supabase-setup.md](docs/supabase-setup.md) for the live project steps. Schema, RLS, and the Supabase store adapter are in `supabase/` and `reader/public/`; `reader/public/supabase-config.json` selects the live backend or the local demo.

## Reader provenance

The renderer, vault model, browser pane interaction and CSS in `reader/` are reused from the local `stacked-notes` project (the agent-wiki viewer). No agent-wiki notes, private repository history, server configuration or local paths were copied. The static adapter replaces its Node API; Wikipedia/server-mounted design panes are not available in this static edition. Existing external URLs remain ordinary outbound links where supported. The demo modules (`reader/public/demo-*.js`) are additive: they decorate rendered notes, and the reader's navigation, search, backlinks, previews and URL behaviour are unchanged.
