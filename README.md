# Vitruvian Institute

A static reader for the Markdown in `vault/`. Edit notes in Obsidian; Markdown is the source of truth.

Notes open one page at a time by default: wikilinks are ordinary links, and browser Back is the reading path. **Settings → Reading** offers stacked tabs as an advanced mode, where earlier notes stay open to the left. Search, backlinks, hover previews, and full-page User / Settings / Admin are available in both modes.

A note may declare its place in the guide with `parents` frontmatter:

```yaml
---
parents: ["Physical wellness"]
---
```

The build validates the IDs and publishes one compact breadcrumb trail from the
first parent. Notes without `parents` show none. **Settings → Reading → Show
breadcrumbs** turns the row off; it is on by default.

**Settings → Appearance** chooses a stylesheet template. The Clear, Paper, and Soft Lilac templates are local. Minimal, Things, and Blue Topaz only adapt colour tokens from MIT-licensed Obsidian themes; sources are cited in `reader/public/themes/`. No theme layout or component CSS is copied.

Participation runs on Supabase in production: public reading, open email sign-up, a private portfolio, evidence storage, reviewer verification, and reading statistics. A signed-out reader can still log an activity without an account: the reflection stays in this browser and moves into the portfolio on the next sign-in. Files need an account. The Markdown guide remains the primary content and is still being authored. A browser-only demo remains available by setting the runtime mode to `local`; see [Local participation demo](#local-participation-demo).

## Status

- **Prod:** https://global-vitruvian-institute.github.io/Global-Vitruvian-Institute/
- **Local:** http://127.0.0.1:4182/
- **Repo:** https://github.com/Global-Vitruvian-Institute/Global-Vitruvian-Institute
- **Supabase:** https://supabase.com/dashboard/project/qplbfsnhrrsmudpnppoy
- **SQL:** https://supabase.com/dashboard/project/qplbfsnhrrsmudpnppoy/sql/new
- **Auth:** https://supabase.com/dashboard/project/qplbfsnhrrsmudpnppoy/auth/users
- **URLs:** https://supabase.com/dashboard/project/qplbfsnhrrsmudpnppoy/auth/url-configuration
- **Email templates:** https://supabase.com/dashboard/project/qplbfsnhrrsmudpnppoy/auth/templates

**Real in prod**
- Markdown content, reading UI, search, backlinks, themes.
- Supabase auth, database, private file storage.
- Admin sign-in works.

**Not yet proven live**
- Activity submission, file upload, reviewer flow, pinning, stats.

**Mock**
- Browser demo only when config says `local`; currently off.

**Open**
- Confirm migration `0003` applied.
- Run one participant → reviewer cycle.

**Docs**
- [docs/supabase-setup.md](docs/supabase-setup.md)
- [docs/production-plan.md](docs/production-plan.md)

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
?note=Breath&stackedNotes=Movement&view=account   User
?note=Breath&stackedNotes=Movement&view=settings  Settings
?note=Breath&stackedNotes=Movement&view=admin     Admin (authorized accounts only)
```

**Return to notes** removes only `view`, so the reading stack, its horizontal position and every note's scroll offset come back exactly as they were. Reload, browser Back/Forward and direct links all reproduce the same page, and `?view=…` works under a project subpath because it is an ordinary query parameter. User stays in the header; Settings and the authorized Admin entry live in the account page's own small navigation row. Header **Random** and **Search** still work from any account page — choosing a note returns to the reader.

**Settings** offers three built-in light appearances, with no account and no dependency:

- **Clear** (default) — white surfaces, charcoal text and blue links.
- **Paper** — warm off-white surfaces with the same blue links.
- **Soft Lilac** — neutral light surfaces with restrained violet accents.
- **Minimal**, **Things**, **Blue Topaz** — palettes adapted from MIT-licensed Obsidian themes.
- **Dark** — charcoal surfaces with soft blue links.
- **Academy** — bright white and high-clarity blue, after Khan Academy reading colours.
- **Editorial** — cream paper, oxblood links and a serif reading face.

Most change colour tokens only. Editorial also switches the reading face to serif. There is no automatic OS theme switch. The choice is stored in this browser's `localStorage` (one key, `vitruvian.appearance`) and applied before first paint; if the browser refuses storage, the preset still applies for the visit and the page says so.

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

This section applies only when `reader/public/supabase-config.json` has `"mode": "local"`. Production uses Supabase. The demo exists to show the participation flow without a backend; it is not the deployed service. The activity notes in `vault/` are placeholders for human-written guidance: the demo records what a reader logs and adds no advice of its own.

**It is deliberately insecure.** There is no server, no API, no real authentication and no email. Accounts, submissions, uploaded evidence and reading statistics live in this browser's IndexedDB for this origin, and may be lost or cleared at any time. Anyone with access to this browser profile can read them, and the demo admin page is designed to inspect every account stored here. Nothing is sent anywhere; nothing syncs between devices or browsers.

### Signing in

1. Choose **Log in** in the top right (or open the settings gear, then **User**).
2. Enter any email address (for example `you@example.com`) and choose *Continue*.
3. Type the demo verification code that is printed on screen: **`482913`**.

There is no password and no verification email; the code is displayed precisely because there is no delivery step. An address that has not been seen before creates a new local account. `admin@vitruvian.demo` additionally reveals an *Admin* entry in the account page's own navigation — the admin view is never a global navigation item.

### Activities, portfolio and review

- An Obsidian-style `> [!activity] Title` callout embeds an activity in its note. Orientation's **What brought you here?** prompt has a response field and save button directly beneath it—no separate reflection page or sign-in gate. Guest responses stay in this browser and move into the account on sign-in; account responses are visible to reviewers. Hover previews show the prompt only, never a form.
- A `> [!chart] Title` callout embeds a chart from [Our World in Data](https://ourworldindata.org/): a title, a caption, the source link and the chart itself. The reader mounts the frame when the note is shown, and the frame defers its own request until it is near the view; hover previews render the card and mount nothing. The renderer accepts only Our World in Data grapher links, and the browser re-checks the URL before it becomes a frame. [[World data]] collects six of them, one per subject, and each subject note links to the relevant section. See [docs/writing.md](docs/writing.md) for the syntax.
- Standalone exercise notes (`Breath`, `Movement`, `Money check-in`) still use `activity: true` for the *Log activity* dialog, including file evidence. `scripts/build.mjs` publishes only the boolean, not raw frontmatter.
- A submission needs a trimmed reflection, a file, or both. New submissions are saved as **pending**.
- **User** paints its headings and loading skeletons immediately, then shows **Your collection**, the complete **Activity history**, **Pinned portfolio**, **Your reading** and account controls. Guest work is also visible without signing in; saved responses expose a **View activity log** link. **Return to notes** preserves the reading stack, fragment and actual scroll positions.
- Collection subjects and activity formats are independently editable in `reader/public/activity-catalog.js`. One equal-area pebble represents one activity; exact labelled counts remain available without colour matching, and motion respects reduced-motion preferences. No balance targets or inferred effort scores are used. See [collection design and sources](docs/activity-collection.md).
- Any of your own submissions can be pinned or unpinned whatever its review status, and pinned items remain in the history too. Pinning and reviewing do not add to the collection.
- **Public portfolio** in Settings and **Vitruvian scholarship** near the bottom of User are **Coming soon**, with disabled controls. Nothing is published and no applications are accepted.
- The admin page lists the seeded synthetic participants and any local accounts created in this browser, with per-account pages explored, active time and submissions. Reviews move a submission between **pending**, **verified** and **changes requested**, requesting changes requires feedback, and every review is kept as a timestamped history event.

### Evidence files

- At most **3 files**, **2 MB each**, **4 MB in total**, per submission.
- PNG, JPEG, GIF, WebP and AVIF preview inside the page. Everything else — including PDF, text, HTML and SVG — is offered as a download whose bytes are served as `application/octet-stream`, so an uploaded file can never be rendered as markup in this origin.
- Evidence is stored as raw bytes in IndexedDB alongside its submission, in one transaction: a failed write leaves nothing half-saved. When the account page goes away its preview URLs are revoked.
- If the browser refuses storage or runs out of room, the reader reports the error and keeps the input. Account submissions and evidence never fall back to `localStorage`; guest reflections use it explicitly, with browser-only storage explained before saving.

### Reading statistics

Active time and distinct pages are measured only for the signed-in reader, only for notes that actually rendered from the vault, and only while the tab is visible, the reader is not idle, no demo dialog is open and the reader is actually showing. Hover previews, failed loads, account pages and pane rebuilds are not pages. Measured figures are labelled *local estimates*; the seeded participants' figures are labelled *synthetic*.

### Clearing local data

**User → Clear local demo data** asks for confirmation, then removes every local account, submission, uploaded file and reading statistic for this origin and restores the synthetic fixtures. Clearing browser storage for the site has the same effect.

## Production

See [docs/production-plan.md](docs/production-plan.md) for the environment plan and [docs/supabase-setup.md](docs/supabase-setup.md) for the live project steps. Schema, RLS, and the Supabase store adapter are in `supabase/` and `reader/public/`; `reader/public/supabase-config.json` selects the live backend or the local demo.

## Reader provenance

The renderer, vault model, browser pane interaction and CSS in `reader/` are reused from the local `stacked-notes` project (the agent-wiki viewer). No agent-wiki notes, private repository history, server configuration or local paths were copied. The static adapter replaces its Node API; Wikipedia/server-mounted design panes are not available in this static edition. Existing external URLs remain ordinary outbound links where supported. The demo modules (`reader/public/demo-*.js`) are additive: they decorate rendered notes, and the reader's navigation, search, backlinks, previews and URL behaviour are unchanged.
