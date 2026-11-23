import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadFrontmatterParser, loadVault } from '../reader/src/vault.js';
import { createRenderer } from '../reader/src/render.js';

const root = resolve(process.env.VAULT_ROOT ?? 'vault');
const out = resolve(process.env.OUT_DIR ?? 'dist');
await loadFrontmatterParser();
const vault = await loadVault(root);
if (!vault.notes.has('Base Note')) throw new Error('The public home note vault/Base Note.md is missing');
const render = createRenderer(vault);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('reader/public', out, { recursive: true });

const parentMap = new Map();
for (const note of vault.noteList()) {
  const declared = note.frontmatter.parents;
  if (!Array.isArray(declared)) continue;
  const valid = declared
    .map((id) => String(id).trim())
    .filter((id) => id && id !== note.id && vault.notes.has(id));
  if (valid.length) parentMap.set(note.id, [...new Set(valid)]);
}

/** The curated first-parent ancestry, root first, current note excluded. */
function breadcrumbsFor(id) {
  const trail = [];
  const seen = new Set([id]);
  let current = id;
  while (parentMap.has(current)) {
    const parent = parentMap.get(current)[0];
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    const note = vault.notes.get(parent);
    trail.unshift({ id: parent, title: note.title });
    current = parent;
  }
  return trail;
}

const notes = Object.create(null);
for (const note of vault.noteList()) {
  // Export only reader fields, never absolute paths, raw frontmatter or Obsidian URLs.
  const html = render(note)
    .replace(/href="\/([^"#]*)(#[^"]*)?"/g, (_, target, fragment = '') =>
      `href="./?note=${encodeURIComponent(decodeURIComponent(target))}${fragment}"`)
    .replace(/src="\/asset\?p=([^"]+)"/g, (_, path) =>
      `src="./assets/${decodeURIComponent(path).split('/').map(encodeURIComponent).join('/')}"`);
  notes[note.id] = {
    id: note.id, title: note.title, source: 'vault', html,
    text: note.body, obsidianUrl: null,
    // The one frontmatter field the reader is allowed to see, and only as a
    // boolean: `activity: true` turns on the local logging control. Raw
    // frontmatter is never published.
    activity: note.frontmatter.activity === true,
    breadcrumbs: breadcrumbsFor(note.id),
    links: note.links.filter(link => link.kind === 'note'), backlinks: note.backlinks,
  };
}
for (const asset of vault.assets.values()) {
  if (!vault.isPublicAsset(asset.path)) continue;
  const destination = resolve(out, 'assets', asset.path);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(resolve(root, asset.path), destination);
}
const title = 'Vitruvian Institute';
await writeFile(resolve(out, 'notes.json'), JSON.stringify({
  bootstrap: {
    app: { title }, vault: { name: title, notes: vault.notes.size, warnings: [] },
    defaultNoteId: 'Base Note', aboutNoteId: 'Orientation',
    features: { search: true, random: true, preview: true },
  }, notes,
}));
let shell = await readFile(resolve(out, 'index.html'), 'utf8');
// The shell already carries the published title; this keeps the two in step if
// the identity ever moves again, without depending on the old value.
shell = shell.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
  .replaceAll('href="/"', 'href="./"')
  .replace('href="/styles.css"', 'href="./styles.css"')
  .replace('src="/app.js"', 'src="./app.js"');
await writeFile(resolve(out, 'index.html'), shell);
await writeFile(resolve(out, '.nojekyll'), '');
console.log(`Built ${vault.notes.size} notes into dist/`);
