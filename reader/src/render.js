/**
 * Markdown → HTML, in Obsidian's dialect.
 *
 * Raw HTML stays off, so nothing in a note can become script. Everything a note
 * points at is resolved through the vault model and rewritten to a route this app
 * owns: a note link becomes `/<note-id>`, an image becomes `/asset?p=<path>`.
 * Unresolvable targets are rendered as inert text rather than a dead link, so a
 * reader can tell "the note says this" from "the note points somewhere real".
 */
import MarkdownIt from 'markdown-it'
import GithubSlugger from 'github-slugger'
import { chartEmbedTarget } from '../public/chart-embed.js'

const IMAGE_TARGET = /\.(png|jpe?g|gif|webp|avif|svg)$/i
// Markdown-it installs this on every instance; captured so the custom image rule
// can fall through to the real one for ordinary local images.
const defaultImageRule = new MarkdownIt({ html: false }).renderer.rules.image

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function createRenderer(vault, { resolveDesign = () => null } = {}) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false })

  // `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[embed]]`.
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const start = state.pos
    const src = state.src
    const isEmbed = src.charCodeAt(start) === 0x21 /* ! */ && src.startsWith('[[', start + 1)
    const open = isEmbed ? start + 1 : start
    if (!src.startsWith('[[', open)) return false
    const close = src.indexOf(']]', open + 2)
    if (close === -1) return false
    const inner = src.slice(open + 2, close)
    if (!inner.trim() || inner.includes('\n')) return false
    if (!silent) state.push(isEmbed ? 'wikilink_embed' : 'wikilink', '', 0)
    if (!silent) {
      const token = state.tokens[state.tokens.length - 1]
      token.meta = { inner }
    }
    state.pos = close + 2
    return true
  })

  md.renderer.rules.wikilink = (tokens, index, options, env) =>
    wikilinkHtml(tokens[index].meta.inner, vault, env?.noteId ?? null)
  md.renderer.rules.wikilink_embed = (tokens, index, options, env) =>
    embedHtml(tokens[index].meta.inner, vault, env?.noteId ?? null)
  md.renderer.rules.wikilink.text = (tokens, index) => tokens[index].meta.inner

  // An activity stays in the note that introduces it. Obsidian-style callouts
  // remain readable Markdown; only their static prompt is built here. The
  // reader adds response controls later, never in hover previews.
  md.core.ruler.push('inline_activities', (state) => {
    const tokens = state.tokens
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].type !== 'blockquote_open'
        || tokens[index + 1]?.type !== 'paragraph_open'
        || tokens[index + 2]?.type !== 'inline') continue
      const first = tokens[index + 2]
      const match = first.content.match(/^\[!activity\]\s+([^\n]+)(?:\n([\s\S]*))?$/)
      if (!match) continue
      const title = match[1].trim()
      let end = index + 1
      let depth = 1
      for (; end < tokens.length; end += 1) {
        if (tokens[end].type === 'blockquote_open') depth += 1
        if (tokens[end].type === 'blockquote_close') depth -= 1
        if (!depth) break
      }
      if (depth) continue

      const open = tokens[index]
      open.type = 'activity_open'
      open.tag = 'section'
      open.attrSet('class', 'inline-activity')
      open.attrSet('data-activity-title', title)
      tokens[end].type = 'activity_close'
      tokens[end].tag = 'section'
      const promptClose = new state.Token('activity_prompt_close', 'div', -1)
      promptClose.block = true
      tokens.splice(end, 0, promptClose)

      const headingOpen = new state.Token('heading_open', 'h2', 1)
      headingOpen.block = true
      headingOpen.attrSet('class', 'inline-activity-title')
      const headingText = new state.Token('inline', '', 0)
      headingText.content = title
      const text = new state.Token('text', '', 0)
      text.content = title
      headingText.children = [text]
      const headingClose = new state.Token('heading_close', 'h2', -1)
      headingClose.block = true
      const promptOpen = new state.Token('activity_prompt_open', 'div', 1)
      promptOpen.block = true
      promptOpen.attrSet('class', 'inline-activity-prompt')
      const replacement = [headingOpen, headingText, headingClose, promptOpen]
      if (match[2]?.trim()) {
        first.content = match[2]
        first.children = []
        md.inline.parse(first.content, md, state.env, first.children)
        replacement.push(tokens[index + 1], first, tokens[index + 3])
      }
      tokens.splice(index + 1, 3, ...replacement)
    }
  })

  // `> [!chart] Title` becomes a chart card, never an iframe. The note supplies a
  // title, a caption and one Our World in Data link; the reader supplies the
  // embed, on request. An unsupported link stays inert text rather than a frame.
  md.core.ruler.push('chart_embeds', (state) => {
    const tokens = state.tokens
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].type !== 'blockquote_open'
        || tokens[index + 1]?.type !== 'paragraph_open'
        || tokens[index + 2]?.type !== 'inline') continue
      const first = tokens[index + 2]
      const match = first.content.match(/^\[!chart\][ \t]*([^\n]*)/)
      if (!match) continue
      let end = index + 1
      let depth = 1
      for (; end < tokens.length; end += 1) {
        if (tokens[end].type === 'blockquote_open') depth += 1
        if (tokens[end].type === 'blockquote_close') depth -= 1
        if (!depth) break
      }
      if (depth) continue

      // Every paragraph of the callout is body. A blank `>` line inside the
      // callout therefore cannot silently drop the chart.
      const paragraphs = []
      for (let at = index + 1; at < end; at += 1) {
        if (tokens[at].type === 'inline') paragraphs.push(tokens[at].content)
      }
      const body = paragraphs.join('\n').replace(/^\[!chart\][^\n]*\n?/, '')

      const token = new state.Token('chart_embed', '', 0)
      token.block = true
      token.level = tokens[index].level
      token.content = chartEmbedHtml(match[1], body, text => md.renderInline(text, state.env))
      tokens.splice(index, end - index + 1, token)
    }
  })
  md.renderer.rules.chart_embed = (tokens, index) => tokens[index].content

  // Heading anchors, slugged the way Obsidian slugs them.
  const slugger = new GithubSlugger()
  md.core.ruler.push('heading_ids', (state) => {
    slugger.reset()
    const tokens = state.tokens
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].type !== 'heading_open') continue
      const inline = tokens[index + 1]
      if (!inline || inline.type !== 'inline') continue
      const slug = slugger.slug(inline.content.trim())
      tokens[index].attrSet('id', slug)
      if (tokens[index - 1]?.type === 'activity_open') {
        tokens[index - 1].attrSet('data-activity-id', slug)
        tokens[index - 1].attrSet('aria-labelledby', slug)
      }
    }
  })

  // Rewrite ordinary markdown links and images into app routes.
  md.core.ruler.push('rewrite_targets', (state) => {
    const noteId = state.env?.noteId ?? null
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        if (child.type === 'link_open') {
          const href = child.attrGet('href') ?? ''
          const design = resolveDesign(href)
          const rewritten = design ? { href: design.href, design: true } : rewriteHref(href, noteId, vault)
          if (rewritten === null) {
            child.attrSet('class', 'note-link missing')
            child.attrSet('aria-disabled', 'true')
            child.attrSet('data-missing', href)
            // No href at all: a dead link should not move the page or take focus.
            child.attrs = (child.attrs ?? []).filter(([name]) => name !== 'href')
          } else if (rewritten.design) {
            child.attrSet('href', rewritten.href)
            child.attrSet('class', 'design-link')
            child.attrSet('data-design-url', rewritten.href)
          } else if (rewritten.external) {
            child.attrSet('href', rewritten.href)
            child.attrSet('rel', 'noreferrer noopener')
            child.attrSet('target', '_blank')
          } else {
            child.attrSet('href', rewritten.href)
            child.attrSet('class', 'note-link')
            child.attrSet('data-note-id', rewritten.id)
            if (rewritten.heading) child.attrSet('data-heading', rewritten.heading)
          }
        }
        if (child.type === 'image') {
          const src = child.attrGet('src') ?? ''
          const rewritten = rewriteImage(src, noteId, vault)
          if (rewritten && typeof rewritten === 'object') {
            child.meta = { ...child.meta, externalImage: rewritten.external }
          } else if (rewritten) {
            child.attrSet('src', rewritten)
            child.attrSet('loading', 'lazy')
          } else {
            child.meta = { ...child.meta, missingImage: true }
          }
        }
      }
    }
  })

  // Remote images are not fetched. The note keeps the reference as a link, so the
  // reader can follow it deliberately instead of a page opening a connection for
  // them. A broken local image is inert text, not a re-requesting `<img src="">`.
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token.meta?.externalImage) {
      const url = escapeHtml(token.meta.externalImage)
      return `<a class="note-link external-image" href="${url}" rel="noreferrer noopener" target="_blank">image: <span>${url}</span></a>`
    }
    if (token.meta?.missingImage) {
      const alt = (token.children ?? []).map((node) => node.content ?? '').join('').trim()
      return `<span class="missing-image">${escapeHtml(alt ? `${alt} (missing image)` : 'missing image')}</span>`
    }
    return defaultImageRule(tokens, index, options, env, self)
  }

  const rendered = new Map()

  return function render(note) {
    const cached = rendered.get(note.id)
    if (cached) return cached
    const html = md.render(note.body, { noteId: note.id })
    rendered.set(note.id, html)
    return html
  }
}

/**
 * One chart card. The body holds an optional caption plus the grapher URL; the
 * first line that is an allowed chart link is the embed, and the rest is prose.
 */
function chartEmbedHtml(rawTitle, rawBody, inline) {
  const lines = String(rawBody).split('\n').map(line => line.trim()).filter(Boolean)
  const at = lines.findIndex(line => chartEmbedTarget(line))
  if (at === -1) {
    // The mistake stays readable and inert: the author sees the link that did
    // not qualify, and the reader never gets a frame from it.
    const offender = lines.find(line => /^[a-z][a-z0-9+.-]*:/i.test(line))
    return '<p class="chart-embed-unsupported" data-chart-unsupported="true">Chart not shown: '
      + 'only an Our World in Data grapher link can be embedded.'
      + `${offender ? ` The link here was ${escapeHtml(offender)}.` : ''}</p>\n`
  }
  const url = chartEmbedTarget(lines[at])
  const title = String(rawTitle).trim()
  // The caption is ordinary note prose: links and emphasis still resolve.
  const caption = inline(lines.filter((_, index) => index !== at).join(' '))
  const href = escapeHtml(url.href)
  const head = [
    title ? `<p class="chart-embed-title">${escapeHtml(title)}</p>` : '',
    caption ? `<p class="chart-embed-text">${caption}</p>` : '',
  ].join('')
  return [
    `<figure class="chart-embed" data-chart-src="${href}"${title ? ` data-chart-title="${escapeHtml(title)}"` : ''}>`,
    head ? `<figcaption class="chart-embed-head">${head}</figcaption>` : '',
    '<div class="chart-embed-body">',
    '<p class="chart-embed-note">This chart is not loaded yet. Loading it fetches data from ourworldindata.org.</p>',
    '<p class="chart-embed-actions"><button class="chart-embed-load" type="button" data-chart-load>Load chart</button></p>',
    '</div>',
    `<p class="chart-embed-source">Chart: <a class="chart-embed-link" href="${href}" rel="noreferrer noopener" target="_blank">Our World in Data</a></p>`,
    '</figure>',
  ].filter(Boolean).join('\n')
}

function splitInner(inner) {
  const [rawTarget, ...aliasParts] = inner.split('|')
  const target = rawTarget.trim()
  const alias = aliasParts.join('|').trim()
  const [name, ...headingParts] = target.split('#')
  return { name: name.trim(), heading: headingParts.join('#').trim() || null, alias: alias || null }
}

function noteHref(id) {
  return '/' + id.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function wikilinkHtml(inner, vault, fromId) {
  const { name, heading, alias } = splitInner(inner)
  if (!name && heading) {
    // `[[#heading]]` means "here", so it stays a same-page anchor.
    const slug = new GithubSlugger().slug(heading)
    return `<a class="note-link" href="#${escapeHtml(slug)}" data-heading="${escapeHtml(slug)}">${escapeHtml(alias ?? heading)}</a>`
  }
  const note = vault.resolveNote(name, fromId)
  const label = escapeHtml(alias ?? (heading ? `${name} › ${heading}` : name || heading || inner))
  if (!note) return `<span class="note-link missing" data-missing="${escapeHtml(name)}">${label}</span>`
  const anchor = heading ? `#${escapeHtml(new GithubSlugger().slug(heading))}` : ''
  return `<a class="note-link" href="${escapeHtml(noteHref(note.id))}${anchor}" data-note-id="${escapeHtml(note.id)}"${
    heading ? ` data-heading="${escapeHtml(new GithubSlugger().slug(heading))}"` : ''
  }>${label}</a>`
}

function embedHtml(inner, vault, fromId) {
  const { name, heading, alias } = splitInner(inner)
  if (IMAGE_TARGET.test(name)) {
    const asset = vault.resolveAsset(name, fromId)
    if (!asset) return `<span class="missing-image">${escapeHtml(alias ?? name)} (missing image)</span>`
    const width = alias && /^\d+$/.test(alias) ? ` width="${alias}"` : ''
    return `<img class="note-image" src="/asset?p=${encodeURIComponent(asset.path)}" alt="${escapeHtml(
      alias ?? name,
    )}" loading="lazy"${width}>`
  }
  const note = vault.resolveNote(name, fromId)
  if (!note) return `<span class="note-link missing" data-missing="${escapeHtml(name)}">${escapeHtml(name)} (missing note)</span>`
  const label = escapeHtml(alias ?? (heading ? `${note.title} › ${heading}` : note.title))
  return `<a class="note-link embed" href="${escapeHtml(noteHref(note.id))}" data-note-id="${escapeHtml(note.id)}">${label}</a>`
}

function rewriteHref(href, noteId, vault) {
  if (!href) return null
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(href)) {
    return /^mailto:|^https?:/i.test(href) ? { external: true, href } : null
  }
  if (href.startsWith('#')) return { href }
  const [pathPart, ...fragment] = href.split('#')
  // A fragment is not part of the target: `note.md#Heading` must still resolve.
  if (!/\.md$/i.test(pathPart) && !pathPart.startsWith('.') && !pathPart.includes('/')) return null
  // A bare note name inside a folder resolves against that folder.
  const note = vault.resolveNote(pathPart, noteId)
  if (!note) return null
  const heading = fragment.join('#')
  const slug = heading ? new GithubSlugger().slug(safeDecode(heading)) : null
  return {
    href: noteHref(note.id) + (slug ? `#${encodeURIComponent(slug)}` : ''),
    id: note.id,
    heading: slug,
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function rewriteImage(src, noteId, vault) {
  if (!src) return null
  // Remote images are not loaded: a note should not make the reader's browser
  // call a third party just by being opened. The note keeps the link.
  if (/^(?:https?:)?\/\//i.test(src)) return { external: src }
  if (src.startsWith('data:')) return null
  const asset = vault.resolveAsset(src, noteId)
  if (!asset) return null
  return `/asset?p=${encodeURIComponent(asset.path)}`
}
