/** Static equivalent of the local reader's API. No server or third-party calls. */
const dataPromise = fetch(new URL('./notes.json', import.meta.url)).then(response => {
  if (!response.ok) throw new Error('Could not load the published notes');
  return response.json();
});

export async function fetchStatic(input) {
  const data = await dataPromise;
  const url = new URL(input, 'https://static.invalid');
  const notes = Object.values(data.notes);
  let payload;
  let status = 200;
  switch (url.pathname) {
    case '/api/bootstrap':
      payload = data.bootstrap;
      break;
    case '/api/note': {
      const note = data.notes[url.searchParams.get('id')];
      if (note) payload = { note };
      break;
    }
    case '/api/search': {
      const query = url.searchParams.get('q') || '';
      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const results = tokens.length ? notes.filter(note => tokens.every(token =>
        `${note.title} ${note.text}`.toLowerCase().includes(token)
      )).sort((a, b) => Number(b.title.toLowerCase().includes(query.toLowerCase())) -
        Number(a.title.toLowerCase().includes(query.toLowerCase())) || a.title.localeCompare(b.title)) : [];
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25));
      payload = { query, results: results.slice(0, limit).map(note => ({
        id: note.id, title: note.title, snippet: note.text.replace(/\s+/g, ' ').slice(0, 160),
      })) };
      break;
    }
    case '/api/random': {
      const choices = notes.filter(note => note.id !== url.searchParams.get('not'));
      const note = choices[Math.floor(Math.random() * choices.length)] || notes[0];
      if (note) payload = { id: note.id, title: note.title };
      break;
    }
  }
  if (!payload) {
    status = 404;
    payload = { error: { code: 'NOTE_NOT_FOUND', message: 'This page is not part of the published notes.' } };
  }
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}
