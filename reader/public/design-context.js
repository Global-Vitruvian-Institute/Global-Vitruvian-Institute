/** Reader-only behavior for explicitly mounted, opaque-origin HTML examples. */
export function designPaneLayout(url) {
  try {
    return new URL(url, 'http://reader.invalid').searchParams.get('layout') === 'canvas'
      ? 'canvas' : 'desktop'
  } catch { return 'desktop' }
}

/** This message contains a note reference, never a URL or an HTML payload. */
export function designContextRequest(data) {
  if (!data || typeof data !== 'object' || data.type !== 'tangible:open-note') return null
  if (typeof data.noteId !== 'string' || !data.noteId || data.noteId.length > 1024) return null
  if (typeof data.heading !== 'string' || data.heading.length > 256) return null
  if (/[\x00-\x1f\x7f]/.test(data.noteId + data.heading)) return null
  return { noteId: data.noteId, heading: data.heading }
}

/**
 * Only a readable note that explicitly links this HTML file can be opened by it.
 * Match actual rendered heading IDs/text, not a guessed slug. The caller checks
 * event.source against the live direct-child iframe before AND after fetching.
 * An opaque origin ('null') is not authentication.
 */
export function designContextHeading(html, designURL, requestedHeading, Parser = DOMParser) {
  const path = value => {
    if (typeof value !== 'string' || !value.startsWith('/design/')) return null
    try { return new URL(value, 'http://reader.invalid').pathname } catch { return null }
  }
  const target = path(designURL)
  if (!target) return null
  const doc = new Parser().parseFromString(html, 'text/html')
  const authorized = Array.from(doc.querySelectorAll('a[data-design-url]'))
    .some(a => path(a.getAttribute('data-design-url')) === target)
  if (!authorized) return null
  if (!requestedHeading) return ''
  const heading = Array.from(doc.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
    .find(el => el.id === requestedHeading || el.textContent.trim() === requestedHeading)
  return heading ? heading.id : null
}
