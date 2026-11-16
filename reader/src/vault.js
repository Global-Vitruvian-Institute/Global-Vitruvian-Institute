/**
 * The vault model: discovery, identity, privacy, link resolution, the link graph,
 * and search. Everything here is read-only and happens once, at boot.
 *
 * Identity is the vault-relative POSIX path without its `.md` extension:
 * `agent-wiki/index`, `concepts/evergreen-notes`, `About these notes`. Paths are
 * stable in a vault (Obsidian moves files rarely), while titles are neither
 * unique nor stable. A move is a new note with a new URL, which is honest.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, relative, resolve as resolvePath, sep } from 'node:path'

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])
const SKIP_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.app', '.stversions'])

/**
 * Audience, not ownership. `private` is the stopped value: a note carrying it is
 * not part of the readable vault at all, even when asked for by id. `ai/private`
 * is the older spelling of the same thing. A note with no such tag is
 * *undesignated* — this reader treats undesignated as readable, because the
 * alternative (a private-by-default vault) would show an empty app.
 */
export const PRIVATE_TAGS = ['private', 'ai/private']

export function isPrivateTag(tag) {
  const value = String(tag).trim().replace(/^#/, '').toLowerCase()
  return PRIVATE_TAGS.some((base) => value === base || value.startsWith(`${base}/`))
}

/** Tags from frontmatter, tolerating a scalar and a `#` prefix. */
export function tagsOf(frontmatter) {
  const raw = frontmatter?.tags
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []
  return list.map((tag) => String(tag).trim().replace(/^#/, '')).filter(Boolean)
}

/**
 * Privacy is a header declaration, so it is read as header syntax, not as text.
 *
 * A title may contain the word "private" (`… on private calls`) and must stay
 * readable; a tag list may spell it without the YAML being valid
 * (`tags: [#private]`) and must still be hidden. The rules below are the narrow
 * middle: they only look at the shapes a declaration can take.
 */
export function headerDeclaresPrivate(header) {
  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // `private: true`, `audience: private`
    if (/^(?:private|audience)\s*:\s*["']?(?:true|yes|on|1|private)["']?\s*$/i.test(trimmed)) return true

    // a list item under tags: `- private`, `- #private/journal`, `- ai/private`
    if (/^-\s*#?(?:ai\/)?private(?:\/[^\s,]*)?\s*$/i.test(trimmed)) return true

    // an inline list: `tags: [private, todo]`, `tags: #private`
    if (/^tags?\s*:\s*/i.test(trimmed)) {
      const values = trimmed.replace(/^tags?\s*:\s*/i, '')
      for (const value of values.split(/[\s,\[\]]+/)) {
        if (isPrivateTag(value)) return true
      }
    }
  }
  return false
}

export function isPrivateNote(frontmatter, rawHeader = '') {
  const tags = tagsOf(frontmatter)
  if (tags.some(isPrivateTag)) return true
  if (frontmatter?.private === true) return true
  if (typeof frontmatter?.private === 'string' && /^(?:true|yes|on|1)$/i.test(frontmatter.private.trim())) return true
  if (String(frontmatter?.audience ?? '').trim().toLowerCase() === 'private') return true
  // The parsed YAML can be absent even when the header says it: an unclosed `---`,
  // or `tags: [#private]`, which YAML rejects. Fail closed by reading the header.
  return rawHeader ? headerDeclaresPrivate(rawHeader) : false
}

function splitPath(relativePath) {
  return relativePath.split('/').filter(Boolean)
}

export function noteIdFor(relativePath) {
  return relativePath.replace(/\.md$/i, '').split(sep).join('/')
}

/** Where a vault-relative path lives, always POSIX, always vault-rooted. */
export function vaultPathFor(root, relativePath) {
  return resolvePath(root, ...splitPath(relativePath))
}

/** Lexical containment. Callers that serve bytes must also check realpath. */
export function isInside(root, candidate) {
  const base = resolvePath(root)
  const full = resolvePath(candidate)
  return full === base || full.startsWith(base + sep)
}

async function walk(root, directory = '', out = []) {
  let entries
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
    const next = directory ? posix.join(directory, entry.name) : entry.name
    if (entry.isDirectory()) await walk(root, next, out)
    else if (entry.isFile()) out.push(next)
    // Symlinks are deliberately not followed: a link can leave the vault.
  }
  return out
}

/** First H1 anywhere in the body, ignoring fenced code. */
export function firstHeading(body) {
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) return match[1].trim()
  }
  return null
}

function basenameOf(relativePath) {
  const name = relativePath.split('/').pop() ?? relativePath
  return name.replace(/\.md$/i, '')
}

function folderOf(relativePath) {
  const parts = splitPath(relativePath)
  parts.pop()
  return parts.join('/')
}

function dedupe(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Build the whole model in one pass.
 *
 * `assets` only holds files some readable note could plausibly show, so a
 * guessed URL cannot reach an image that only a private note used.
 */
export async function loadVault(root, options = {}) {
  // A typo in the vault path must not look like an empty vault.
  try {
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error(`${root} is not a directory`)
    await readdir(root)
  } catch (error) {
    throw new Error(`cannot read vault at ${root}: ${error.code ?? error.message}`)
  }

  const files = await walk(root)
  const notes = new Map()
  const assets = new Map()
  const warnings = []
  const extraNotes = options.extraNotes ?? []
  const scope = options.scope ? String(options.scope).replace(/^\/+|\/+$/g, '').replace(/\\/g, '/') : null

  for (const relativePath of files) {
    // `--scope` reads a subtree. Images are still indexed from the whole vault,
    // because Obsidian keeps attachments where it likes; only note visibility is
    // scoped, and the asset allowlist still requires a readable note to point at
    // the image.
    const inScope = !scope || relativePath === scope || relativePath.startsWith(`${scope}/`)
    if (/\.md$/i.test(relativePath)) {
      if (!inScope) continue
      const raw = await readFile(vaultPathFor(root, relativePath), 'utf8')
      const stats = await stat(vaultPathFor(root, relativePath))
      const note = parseNote(relativePath, raw, stats.mtimeMs)
      if (note.private) continue
      notes.set(note.id, note)
    } else if (IMAGE_EXTENSIONS.has(relativePath.split('.').pop().toLowerCase())) {
      assets.set(relativePath, { path: relativePath, name: basenameOf(relativePath) })
    }
  }

  // Notes that belong to the reader, not the vault: the "About these notes"
  // fallback. A vault note with the same id always wins.
  for (const extra of extraNotes) {
    if (notes.has(extra.id)) continue
    notes.set(extra.id, { frontmatter: {}, body: extra.body, raw: extra.body, links: [], backlinks: [], mtimeMs: 0, ...extra })
  }

  const lower = new Map()
  const byBasename = new Map()
  const byTitle = new Map()
  for (const note of notes.values()) {
    lower.set(note.id.toLowerCase(), note)
    const base = basenameOf(note.path).toLowerCase()
    if (!byBasename.has(base)) byBasename.set(base, [])
    byBasename.get(base).push(note)
    const title = note.title.trim().toLowerCase()
    if (title && title !== base) {
      if (!byTitle.has(title)) byTitle.set(title, [])
      byTitle.get(title).push(note)
    }
  }

  const assetByBasename = new Map()
  const assetLower = new Map()
  for (const asset of assets.values()) {
    assetLower.set(asset.path.toLowerCase(), asset)
    const name = asset.name.toLowerCase()
    if (!assetByBasename.has(name)) assetByBasename.set(name, [])
    assetByBasename.get(name).push(asset)
  }

  const resolveNote = makeNoteResolver({ lower, byBasename, byTitle })
  const resolveAsset = makeAssetResolver({ assets, assetLower, assetByBasename })

  const context = { root, notes, resolveNote, resolveAsset, warnings, byTitle }
  for (const note of notes.values()) {
    note.links = collectNoteLinks(note, context)
    note.backlinks = []
  }
  for (const note of notes.values()) {
    for (const link of note.links) {
      if (link.id === note.id) continue
      const target = notes.get(link.id)
      if (target) target.backlinks.push({ id: note.id, title: note.title, heading: link.heading ?? null })
    }
  }
  for (const note of notes.values()) note.backlinks.sort((a, b) => a.title.localeCompare(b.title))

  // Only images a readable note actually points at are servable. An image used
  // solely by a private note is not reachable by guessing its path.
  const referencedAssets = new Set()
  for (const note of notes.values()) {
    for (const link of note.links) if (link.kind === 'asset') referencedAssets.add(link.path)
  }

  return {
    root,
    notes,
    assets,
    warnings,
    resolveNote,
    resolveAsset,
    isPublicAsset: (path) => referencedAssets.has(path),
    noteList: () => [...notes.values()],
  }
}

export function parseNote(relativePath, raw, mtimeMs = 0) {
  const note = {
    id: noteIdFor(relativePath),
    path: relativePath,
    source: 'vault',
    frontmatter: {},
    body: raw,
    raw,
    mtimeMs,
  }
  const split = splitFrontmatter(raw)
  note.frontmatter = split.data
  note.body = split.body
  note.private = isPrivateNote(note.frontmatter, split.header ?? '')
  const declared = typeof note.frontmatter.title === 'string' ? note.frontmatter.title.trim() : ''
  note.title = declared || firstHeading(note.body) || basenameOf(relativePath)
  return note
}

/**
 * Split `---` frontmatter from the body. Obsidian writes LF, but tolerate CRLF.
 * Malformed YAML is not fatal: the whole file becomes body, so a broken header
 * degrades to a readable note rather than an error.
 */
export function splitFrontmatter(raw) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) {
    // An opened-but-unclosed header still counts as a header for privacy: the
    // alternative is publishing a note whose author meant to mark it private.
    return { data: {}, body: raw, header: /^\uFEFF?---\r?\n/.test(raw) ? raw : '' }
  }
  const header = match[1]
  try {
    const data = parseYaml(header)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: {}, body: raw, header }
    return { data, body: raw.slice(match[0].length), header }
  } catch {
    // Unparseable but delimited: still a header, so privacy can be read from it.
    return { data: {}, body: raw.slice(match[0].length), header }
  }
}

let parseYaml = (value) => {
  throw new Error('YAML parser not loaded: await loadFrontmatterParser() before reading a vault')
}
export async function loadFrontmatterParser() {
  const mod = await import('yaml')
  parseYaml = (mod.default ?? mod).parse
}

function makeNoteResolver({ lower, byBasename, byTitle }) {
  return function resolveNote(target, fromId = null) {
    if (!target) return null
    let value = String(target).trim()
    if (!value) return null
    // Aliases and headings are not part of the target.
    value = value.split('|')[0].split('#')[0].trim()
    if (!value) return fromId ? null : null
    value = value.replace(/\\/g, '/').replace(/^\.\//, '')
    if (value.startsWith('/')) value = value.slice(1)
    if (/\.md$/i.test(value)) value = value.slice(0, -3)

    if (fromId) {
      const base = folderOf(`${fromId}.md`)
      const joined = posix.normalize(posix.join(base, value))
      if (!joined.startsWith('..')) {
        const hit = lower.get(joined.toLowerCase())
        if (hit) return hit
      }
    }

    const direct = lower.get(value.toLowerCase())
    if (direct) return direct

    if (!value.includes('/')) {
      const base = value.toLowerCase()
      const candidates = byBasename.get(base)
      if (candidates?.length === 1) return candidates[0]
      if (candidates?.length > 1) return null // ambiguous: better missing than wrong
      const titled = byTitle.get(base)
      if (titled?.length === 1) return titled[0]
    }

    return null
  }
}

function makeAssetResolver({ assets, assetLower, assetByBasename }) {
  return function resolveAsset(reference, fromId = null) {
    if (!reference) return null
    let value = String(reference).trim().replace(/^<|>$/g, '')
    if (!value || /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith('data:')) return null
    value = value.split('?')[0].split('#')[0]
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
    value = value.replace(/\\/g, '/')
    if (value.startsWith('/')) value = value.slice(1)

    if (fromId) {
      const base = folderOf(`${fromId}.md`)
      const joined = posix.normalize(posix.join(base, value))
      if (!joined.startsWith('..')) {
        const hit = assets.get(joined) ?? assetLower.get(joined.toLowerCase())
        if (hit) return hit
      }
    }
    const direct = assets.get(value) ?? assetLower.get(value.toLowerCase())
    if (direct) return direct

    const candidates = assetByBasename.get(value.split('/').pop().toLowerCase())
    if (candidates?.length === 1) return candidates[0]
    if (candidates?.length > 1) {
      // Obsidian puts attachments at the vault root by default; prefer that.
      const rootLevel = candidates.find((asset) => !asset.path.includes('/'))
      return rootLevel ?? null
    }
    return null
  }
}

/**
 * Everything a note points at, resolved. One pass, used for backlinks, for the
 * "links" list the client keeps warm, and for authorising assets.
 */
export function collectNoteLinks(note, context) {
  const out = []
  // Code is not a link. A fenced example or an inline span naming an image must
  // not authorise that image for the whole reader.
  const body = note.body
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '')

  // Wikilinks and embeds. `![[x]]` is an embed: image, or a note reference.
  for (const match of body.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const [, bang, inner] = match
    const [rawTarget, ...aliasParts] = inner.split('|')
    const target = rawTarget.trim()
    const heading = target.includes('#') ? target.split('#')[1]?.trim() ?? null : null
    const name = target.split('#')[0].trim()

    if (bang) {
      const asset = context.resolveAsset(name, note.id)
      if (asset) {
        out.push({ kind: 'asset', path: asset.path })
        continue
      }
    }
    const resolved = context.resolveNote(target, note.id)
    if (resolved) out.push({ kind: 'note', id: resolved.id, title: resolved.title, heading, alias: aliasParts.join('|').trim() || null })
  }

  // Ordinary markdown links and images.
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]
    if (/^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) continue
    if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(href)) {
      const asset = context.resolveAsset(href, note.id)
      if (asset) out.push({ kind: 'asset', path: asset.path })
      continue
    }
    if (!/\.md$/i.test(href) && !href.startsWith('./') && !href.startsWith('../')) continue
    const resolved = context.resolveNote(href, note.id)
    if (resolved) out.push({ kind: 'note', id: resolved.id, title: resolved.title, heading: null, alias: null })
  }

  return dedupe(out.map((link) => JSON.stringify(link))).map((json) => JSON.parse(json))
}

/* ---------------------------------------------------------------- search --- */

function score(haystack, needle) {
  const index = haystack.indexOf(needle)
  // A long note must not score a real match into negative numbers: the caller
  // reads a negative score as "not found".
  if (index !== -1) return Math.max(1, 100 - index * 0.5 - (haystack.length - needle.length) * 0.001)
  // Ordered subsequence: `evrgrn` finds `Evergreen`.
  let position = 0
  let gaps = 0
  let last = -1
  for (const char of needle) {
    const found = haystack.indexOf(char, position)
    if (found === -1) return -1
    if (last !== -1) gaps += found - last - 1
    last = found
    position = found + 1
  }
  return Math.max(1, 40 - gaps * 0.5 - last * 0.1)
}

/** Rank title matches above body matches; every token must appear somewhere. */
export function searchNotes(notes, query, limit = 50) {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return []
  const tokens = text.split(/\s+/).filter(Boolean)
  const results = []
  for (const note of notes) {
    const title = note.title.toLowerCase()
    const body = note.body.toLowerCase().replace(/\s+/g, ' ')
    let total = 0
    let matchedEveryToken = true
    for (const token of tokens) {
      const inTitle = score(title, token)
      const inBody = score(body, token)
      if (inTitle < 0 && inBody < 0) {
        matchedEveryToken = false
        break
      }
      total += inTitle >= 0 ? inTitle + 60 : inBody
    }
    if (!matchedEveryToken) continue
    results.push({ id: note.id, title: note.title, snippet: snippetFor(note.body, tokens[0]), score: total })
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return results.slice(0, limit)
}

export function snippetFor(body, token) {
  const plain = body.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`>#[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  const at = plain.toLowerCase().indexOf(String(token ?? '').toLowerCase())
  if (at === -1) return plain.slice(0, 140)
  const start = Math.max(0, at - 60)
  return `${start > 0 ? '…' : ''}${plain.slice(start, start + 160).trim()}${start + 160 < plain.length ? '…' : ''}`
}

/* ------------------------------------------------------------- selection --- */

export const START_PRIORITY = ['About these notes', 'README', 'index']

/** The page `/` opens, in the order the brief asked for. Notes the reader ships
 *  with (the built-in About page) are the last resort, never the first choice. */
export function pickDefaultNote(vault, configured = null) {
  if (configured) {
    const hit = vault.resolveNote(configured)
    if (hit) return hit
    vault.warnings.push(`--start "${configured}" did not match a readable note; using the default order.`)
  }
  const vaultNotes = vault.noteList().filter((note) => note.source !== 'app')
  for (const name of START_PRIORITY) {
    const hit = vault.resolveNote(name)
    if (hit && hit.source !== 'app') return hit
  }
  const shipped = vault.noteList().find((note) => note.source === 'app')
  if (shipped) return shipped
  return vaultNotes.sort((a, b) => a.path.localeCompare(b.path))[0] ?? null
}

export function randomNote(vault, excludeId = null) {
  const pool = vault.noteList().filter((note) => note.id !== excludeId)
  if (!pool.length) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

export { basenameOf, folderOf, relative }
