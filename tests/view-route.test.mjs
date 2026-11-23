/**
 * The reader's URL shape, as pure functions.
 *
 * `view-route.js` owns no DOM and no history, so every rule the reader relies on
 * — the reading stack, the region, the hash, and the migration of the old
 * pane-based account URLs — is tested here without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_VIEW_IDS,
  buildRouteQuery,
  isAccountView,
  isLegacyViewId,
  LEGACY_VIEW_IDS,
  normalizeView,
  parseViewRoute,
  VIEW_ACCOUNT,
  VIEW_ADMIN,
  VIEW_READER,
  VIEW_SETTINGS,
} from '../reader/public/view-route.js';
import { DEMO_PANE_IDS } from '../reader/public/demo-model.js';

test('a reading stack and every account region round-trip', () => {
  const routes = [
    { ids: ['Breath'], view: VIEW_READER, hash: '' },
    { ids: ['Breath', 'Movement'], view: VIEW_READER, hash: '' },
    { ids: ['Breath', 'Movement'], view: VIEW_ACCOUNT, hash: '' },
    { ids: ['Breath', 'Movement'], view: VIEW_SETTINGS, hash: '' },
    { ids: ['Breath', 'Movement'], view: VIEW_ADMIN, hash: '' },
    { ids: ['A B', 'C/D'], view: VIEW_ACCOUNT, hash: '' },
    { ids: ['Breath'], view: VIEW_ACCOUNT, hash: 'First heading' },
  ];

  for (const route of routes) {
    const query = buildRouteQuery(route);
    const [search, fragment = ''] = query.split('#');
    const parsed = parseViewRoute(search, fragment ? `#${fragment}` : '');
    assert.deepEqual(parsed.ids, route.ids, `ids survive ${query}`);
    assert.equal(parsed.view, route.view, `region survives ${query}`);
    assert.equal(parsed.hash, route.hash, `hash survives ${query}`);
    assert.equal(parsed.changed, false, `${query} is already canonical`);
  }
});

test('the reading URL never carries a redundant view parameter', () => {
  assert.equal(buildRouteQuery({ ids: ['Breath'], view: VIEW_READER }), '?note=Breath');
  assert.equal(buildRouteQuery({ ids: [], view: VIEW_READER }), '');
  assert.equal(buildRouteQuery({ ids: [], view: VIEW_ACCOUNT }), '?view=account');
});

test('note ids are encoded as one value each, in order', () => {
  const query = buildRouteQuery({ ids: ['A B', 'C/D', 'E&F'], view: VIEW_ACCOUNT });
  const params = new URLSearchParams(query);
  assert.equal(params.get('note'), 'A B');
  assert.deepEqual(params.getAll('stackedNotes'), ['C/D', 'E&F']);
  assert.equal(params.get('view'), VIEW_ACCOUNT);
});

test('unknown views normalise to the reader and ask to be rewritten', () => {
  for (const value of ['bogus', 'ACCOUNT!', 'account2', '']) {
    const parsed = parseViewRoute(`?note=Breath&view=${encodeURIComponent(value)}`);
    assert.equal(parsed.view, VIEW_READER, `${JSON.stringify(value)} is not a region`);
  }
  // Surrounding whitespace and case are forgiving, and the tidied value is
  // written back rather than left as the reader found it.
  assert.equal(parseViewRoute('?note=Breath&view=%20admin%20').view, VIEW_ADMIN);
  assert.equal(parseViewRoute('?note=Breath&view=%20admin%20').changed, true);
  // An empty `view=` is an unknown value too, so the URL is rewritten.
  assert.equal(parseViewRoute('?note=Breath&view=').changed, true);
  assert.equal(parseViewRoute('?note=Breath&view=bogus').changed, true);
  // Case is normalised, and the normalisation is written back.
  assert.equal(parseViewRoute('?note=Breath&view=Account').view, VIEW_ACCOUNT);
  assert.equal(parseViewRoute('?note=Breath&view=Account').changed, true);
  // `view=reader` says nothing the URL does not already say, but it is a known
  // value: the region is the reader either way.
  assert.equal(parseViewRoute('?note=Breath&view=reader').view, VIEW_READER);
  assert.equal(parseViewRoute('?note=Breath&view=reader').changed, false);
  // A known account region is left exactly as it is.
  assert.equal(parseViewRoute('?note=Breath&view=settings').changed, false);
  assert.equal(parseViewRoute('?note=Breath').changed, false);
});

test('normalizeView only ever answers with a known region', () => {
  assert.deepEqual([...ACCOUNT_VIEW_IDS], [VIEW_ACCOUNT, VIEW_SETTINGS, VIEW_ADMIN]);
  for (const value of [null, undefined, 0, {}, [], 'reader', 'nope']) {
    assert.equal(normalizeView(value), VIEW_READER);
  }
  assert.equal(isAccountView(VIEW_READER), false);
  assert.equal(isAccountView(VIEW_ACCOUNT), true);
  assert.equal(isAccountView(VIEW_SETTINGS), true);
  assert.equal(isAccountView(VIEW_ADMIN), true);
});

test('legacy demo pane ids migrate to their region and leave the stack in order', () => {
  const account = parseViewRoute('?note=Breath&stackedNotes=demo%3Aaccount&stackedNotes=Movement');
  assert.deepEqual(account.ids, ['Breath', 'Movement'], 'real notes keep their order');
  assert.equal(account.view, VIEW_ACCOUNT);
  assert.equal(account.legacy, VIEW_ACCOUNT);
  assert.equal(account.changed, true, 'the old URL must be rewritten');

  const admin = parseViewRoute('?note=demo%3Aadmin&stackedNotes=Breath');
  assert.deepEqual(admin.ids, ['Breath']);
  assert.equal(admin.view, VIEW_ADMIN);

  // The frontmost reserved id is the pane that was on screen, so it wins.
  const both = parseViewRoute('?note=demo%3Aaccount&stackedNotes=demo%3Aadmin');
  assert.deepEqual(both.ids, []);
  assert.equal(both.view, VIEW_ADMIN);

  // A URL that was only reserved ids has nothing left for the caller, which is
  // why `app.js` then falls back to the default note.
  const only = parseViewRoute('?note=demo%3Aaccount');
  assert.deepEqual(only.ids, []);
  assert.equal(only.view, VIEW_ACCOUNT);
  assert.equal(only.changed, true);
});

test('reserved ids are never written back into a URL', () => {
  const query = buildRouteQuery({ ids: ['Breath'], view: VIEW_ACCOUNT });
  assert.doesNotMatch(query, /demo/);
  // The migration is one-way: parsing a migrated URL yields an ordinary one.
  const migrated = parseViewRoute('?note=demo%3Aaccount&stackedNotes=Breath');
  const canonical = buildRouteQuery({ ids: migrated.ids, view: migrated.view });
  assert.equal(canonical, '?note=Breath&view=account');
  assert.equal(parseViewRoute(canonical).changed, false);
});

test('legacy ids are recognised by exact value only', () => {
  assert.equal(isLegacyViewId('demo:account'), true);
  assert.equal(isLegacyViewId('demo:admin'), true);
  assert.equal(isLegacyViewId('demo:other'), false);
  assert.equal(isLegacyViewId('demo:account '), false);
  assert.deepEqual(Object.keys(LEGACY_VIEW_IDS).sort(), ['demo:account', 'demo:admin']);
  // The migration table and the demo model's reserved ids must not drift apart.
  assert.deepEqual([...DEMO_PANE_IDS].sort(), Object.keys(LEGACY_VIEW_IDS).sort());
});

test('the hash survives a region change and is stripped of its marker', () => {
  assert.equal(
    buildRouteQuery({ ids: ['Breath'], view: VIEW_ACCOUNT, hash: 'A heading' }),
    '?note=Breath&view=account#A heading',
  );
  assert.equal(parseViewRoute('?note=Breath&view=account', '#A heading').hash, 'A heading');
  assert.equal(parseViewRoute('', '#').hash, '');
  // Switching regions is the removal of exactly one key: the reading stack and
  // the hash are untouched, which is what "Return to notes" relies on.
  const account = parseViewRoute('?note=Breath&stackedNotes=Movement&view=account', '#A heading');
  const returnedQuery = buildRouteQuery({ ids: account.ids, view: VIEW_READER, hash: account.hash });
  const [search, fragment] = returnedQuery.split('#');
  const returned = new URLSearchParams(search);
  assert.equal(returned.get('note'), 'Breath');
  assert.equal(returned.get('stackedNotes'), 'Movement');
  assert.equal(returned.has('view'), false);
  assert.equal(fragment, 'A heading');
});

test('activity history section round-trips independently of the reading fragment', () => {
  const route = {
    ids: ['Orientation', 'Breath'], view: VIEW_ACCOUNT,
    section: 'activity-history', hash: 'what-brought-you-here',
  };
  const query = buildRouteQuery(route);
  assert.equal(query, '?note=Orientation&stackedNotes=Breath&view=account&section=activity-history#what-brought-you-here');
  const [search, fragment] = query.split('#');
  const parsed = parseViewRoute(search, `#${fragment}`);
  assert.deepEqual(parsed.ids, route.ids);
  assert.equal(parsed.section, route.section);
  assert.equal(parsed.hash, route.hash);
  assert.equal(parsed.changed, false, 'known canonical routes retain the section');
  assert.equal(buildRouteQuery({ ...parsed, view: VIEW_READER }),
    '?note=Orientation&stackedNotes=Breath#what-brought-you-here',
    'Return removes both account keys, not the note fragment');
  assert.equal(parseViewRoute('?view=account', '#activity-history').section, null,
    'a reading fragment is never interpreted as an account section');
});

test('invalid sections are removed, including valid sections on other regions', () => {
  for (const view of [VIEW_READER, VIEW_ACCOUNT, VIEW_SETTINGS, VIEW_ADMIN]) {
    for (const section of ['', 'bogus', 'Activity-history', ' activity-history ', 'activity-history']) {
      if (view === VIEW_ACCOUNT && section === 'activity-history') continue;
      const parsed = parseViewRoute(`?note=Breath&view=${view}&section=${encodeURIComponent(section)}`, '#Reading');
      assert.equal(parsed.section, null, `${view}/${JSON.stringify(section)}`);
      assert.equal(parsed.changed, true);
      const canonical = buildRouteQuery(parsed);
      assert.equal(canonical.includes('section='), false);
      assert.equal(parseViewRoute(canonical.split('#')[0], '#Reading').changed, false);
      assert.equal(parsed.hash, 'Reading');
    }
  }
});

test('the query is relative, so a project subpath needs no server route', () => {
  // Nothing here begins with `/`: the caller prefixes `./`, which is what keeps
  // `https://host/vitruvian/` working without a server-side account path.
  for (const view of [VIEW_READER, VIEW_ACCOUNT, VIEW_SETTINGS, VIEW_ADMIN]) {
    const query = buildRouteQuery({ ids: ['Base Note'], view });
    assert.equal(query.startsWith('?') || query === '', true, query);
    assert.equal(query.includes('//'), false, query);
  }
  // Parsing accepts a search string with or without its leading `?`.
  assert.deepEqual(parseViewRoute('?note=Breath').ids, parseViewRoute('note=Breath').ids);
});

test('a URL that names nothing reports it, and a named one says so', () => {
  assert.equal(parseViewRoute('').named, false);
  assert.deepEqual(parseViewRoute('').ids, []);
  assert.equal(parseViewRoute('?view=account').named, false);
  assert.equal(parseViewRoute('?view=account').view, VIEW_ACCOUNT);
  assert.equal(parseViewRoute('?note=').named, true);
  assert.deepEqual(parseViewRoute('?note=').ids, ['']);
  // An empty id is not a legacy id, so it survives for the caller to reject.
  assert.equal(parseViewRoute('?note=').changed, false);
});
