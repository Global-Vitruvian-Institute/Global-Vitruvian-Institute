/** Shared URL rules. Only ordinary HTTPS English Wikipedia article URLs opt in. */
// The empty path segment cannot occur in a valid vault note id.
const PREFIX = '@wikipedia//';

function validTitle(title) {
  return title.length > 0 && title.length <= 512 && title === title.trim() && !/[\u0000-\u001f\u007f]/.test(title);
}

export function wikipediaPage(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    if (!['en.wikipedia.org', 'en.m.wikipedia.org'].includes(url.hostname)) return null;
    if (!url.pathname.startsWith('/wiki/') || url.search) return null;
    const title = decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ').trim();
    if (!validTitle(title)) return null;
    return { title, id: PREFIX + encodeURIComponent(title), heading: decodeURIComponent(url.hash.slice(1)) };
  } catch {
    return null;
  }
}

export function wikipediaArticle(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  try {
    const title = decodeURIComponent(id.slice(PREFIX.length));
    if (!validTitle(title) || PREFIX + encodeURIComponent(title) !== id) return null;
    const url = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replaceAll(' ', '_'));
    return { title, url };
  } catch {
    return null;
  }
}
