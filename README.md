# Global Vitruvian Institute

A static, stacked-pane reader for the Markdown in `vault/`. Edit notes in Obsidian; Markdown is the source of truth. Following a wikilink opens another pane, preserving your reading path. Includes search, backlinks, hover previews and shareable stacks.

## Local preview

Requires Node.js 22+ and Python 3 for this preview command.

```sh
npm ci
npm test
npm run build
python3 -m http.server 4182 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4182/. Rebuild after editing notes. The home page is `vault/Base Note.md`. URLs use `?note=…&stackedNotes=…`, so links and reloads work on static hosting, including GitHub Pages project subpaths.

## Publish

In repository **Settings → Pages → Build and deployment**, select **GitHub Actions**. Pushes to `main` build and deploy `dist/` using `.github/workflows/pages.yml`.

Only generated reader files and rendered notes are deployed. Obsidian settings, dependencies, archives and local environment files are ignored by Git. **Treat every tracked Markdown note as public:** the reader excludes private-tagged notes from its output, but that does not hide files committed to a public repository.

## Reader provenance

The renderer, vault model, browser pane interaction and CSS in `reader/` are reused from the local `stacked-notes` project (the agent-wiki viewer). No agent-wiki notes, private repository history, server configuration or local paths were copied. The static adapter replaces its Node API; Wikipedia/server-mounted design panes are not available in this static edition. Existing external URLs remain ordinary outbound links where supported.
