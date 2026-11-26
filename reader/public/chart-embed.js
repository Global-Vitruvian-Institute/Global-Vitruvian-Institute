/**
 * Our World in Data chart cards.
 *
 * A note never contains an iframe. A `> [!chart]` callout renders a title, a
 * caption, a source link and an empty body; this module puts the real chart in
 * that body when the note is shown in a pane.
 *
 * Two things follow from mounting frames here rather than in the Markdown:
 *
 *  - Hover previews render the same note HTML but are never mounted, so a
 *    preview shows the card's words and fetches nothing.
 *  - `chartEmbedTarget` is the one allowlist. The build refuses to emit a card
 *    for anything but an Our World in Data grapher URL, and the browser checks
 *    the URL again before it becomes a frame.
 */

const LIVE_HOSTS = new Set(['ourworldindata.org', 'www.ourworldindata.org'])
const ARCHIVE_HOST = 'archive.ourworldindata.org'

// A grapher chart needs its own scripts, and its "Explore" links open a new tab.
// The frame keeps its own origin, so it can never reach this page's DOM.
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms'
const FRAME_ALLOW = 'web-share; clipboard-write'

/** An allowed grapher URL, or `null` for anything else. */
export function chartEmbedTarget(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
  if (LIVE_HOSTS.has(url.hostname)) {
    if (!/^\/grapher\/[a-z0-9_-]+$/.test(url.pathname)) return null
  } else if (url.hostname === ARCHIVE_HOST) {
    // An archived chart is a frozen copy: /<timestamp>/grapher/<slug>.html
    if (!/^\/\d{8}-\d{6}\/grapher\/[a-z0-9_-]+\.html$/.test(url.pathname)) return null
  } else {
    return null
  }
  return url
}

/** Build the frame for one card. Exported so a test can inspect it. */
export function chartEmbedFrame(figure, doc = document) {
  const target = chartEmbedTarget(figure?.dataset?.chartSrc)
  if (!target) return null
  const frame = doc.createElement('iframe')
  frame.className = 'chart-embed-frame'
  frame.src = target.href
  frame.title = figure.dataset.chartTitle || 'Our World in Data chart'
  // Our World in Data's own embed snippet defers an offscreen chart, and so do
  // we: the frame is in the page, the request waits until it is near the view.
  frame.setAttribute('loading', 'lazy')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('allow', FRAME_ALLOW)
  frame.setAttribute('sandbox', FRAME_SANDBOX)
  return frame
}

/**
 * Put one card's chart in its body. Returns false when the card has already
 * been mounted or when its URL is not an allowed grapher link.
 */
export function loadChartEmbed(figure, doc = document) {
  if (!figure || figure.dataset.chartLoaded === 'true') return false
  const frame = chartEmbedFrame(figure, doc)
  const body = figure.querySelector('.chart-embed-body')
  if (!frame || !body) return false
  body.replaceChildren(frame)
  figure.dataset.chartLoaded = 'true'
  return true
}

/** Mount every chart in a rendered article. Each card is mounted once. */
export function mountChartEmbeds(root) {
  if (!root?.querySelectorAll) return
  for (const figure of root.querySelectorAll('figure.chart-embed[data-chart-src]')) {
    loadChartEmbed(figure)
  }
}
