import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_KEY,
  addGuestEntry,
  claimGuestEntry,
  guestEntryFor,
  readGuestEntries,
  removeGuestEntries,
  upsertGuestEntry,
} from '../reader/public/guest.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('an anonymous reflection is stored, read back and removable', () => {
  const storage = memoryStorage();
  const entry = addGuestEntry(
    { noteId: 'Breath', noteTitle: 'Breath', reflection: '  Two breaths.  ' },
    { storage, now: () => new Date('2026-11-22T10:00:00Z') },
  );
  assert.equal(entry.reflection, 'Two breaths.');
  assert.equal(readGuestEntries(storage).length, 1);
  assert.equal(guestEntryFor('Breath', storage).id, entry.id);
  assert.equal(readGuestEntries(storage)[0].at, '2026-11-22T10:00:00.000Z');
  removeGuestEntries([entry.id], storage);
  assert.deepEqual(readGuestEntries(storage), []);
});

test('an empty reflection or refused storage stores nothing', () => {
  const storage = memoryStorage();
  assert.equal(addGuestEntry({ noteId: 'Breath', reflection: '   ' }, { storage }), null);
  assert.deepEqual(readGuestEntries(storage), []);
  const refused = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
  assert.equal(addGuestEntry({ noteId: 'Breath', reflection: 'x' }, { storage: refused }), null);
});

test('a missing storage object is reported as a failure, not a silent save', () => {
  // No storage at all: the caller has to be able to tell the reader that
  // nothing was kept. A bare object with no `setItem` is a refusal too.
  for (const storage of [null, {}, { getItem: () => null }]) {
    assert.equal(addGuestEntry({ noteId: 'Breath', reflection: 'x' }, { storage }), null);
    assert.equal(upsertGuestEntry({ noteId: 'Breath', reflection: 'x' }, { storage }), null);
  }
  const refused = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
  assert.equal(addGuestEntry({ noteId: 'Breath', reflection: 'x' }, { storage: refused }), null);
  assert.equal(upsertGuestEntry({ noteId: 'Breath', reflection: 'x' }, { storage: refused }), null);
  // An empty reflection is refused before storage is ever touched.
  const storage = memoryStorage();
  assert.equal(upsertGuestEntry({ noteId: 'Breath', reflection: '   ' }, { storage }), null);
  assert.deepEqual(readGuestEntries(storage), []);
});

test('upserting one activity slot keeps its id and never appends a duplicate', () => {
  const storage = memoryStorage();
  const first = upsertGuestEntry(
    { noteId: 'Orientation#what-brought-you-here', noteTitle: 'What brought you here?', reflection: '  First.  ' },
    { storage, now: () => new Date('2026-11-22T10:00:00Z') },
  );
  assert.equal(first.reflection, 'First.');

  const second = upsertGuestEntry(
    { noteId: 'Orientation#what-brought-you-here', noteTitle: 'What brought you here?', reflection: 'Second.' },
    { storage, now: () => new Date('2026-11-22T11:00:00Z') },
  );
  assert.equal(second.id, first.id, 'an edit keeps the stored id');
  assert.equal(second.at, '2026-11-22T11:00:00.000Z', 'an edit refreshes the timestamp');
  assert.equal(readGuestEntries(storage).length, 1, 'an edit must not append a second entry');
  assert.equal(guestEntryFor('Orientation#what-brought-you-here', storage).reflection, 'Second.');

  // Another slot is a separate entry, and re-saving the first leaves it alone.
  upsertGuestEntry({ noteId: 'Breath', noteTitle: 'Breath', reflection: 'Breath.' }, { storage });
  upsertGuestEntry({ noteId: 'Orientation#what-brought-you-here', reflection: 'Third.' }, { storage });
  const entries = readGuestEntries(storage);
  assert.equal(entries.length, 2);
  assert.equal(guestEntryFor('Breath', storage).reflection, 'Breath.');
  assert.equal(guestEntryFor('Orientation#what-brought-you-here', storage).reflection, 'Third.');
  assert.equal(guestEntryFor('Orientation#what-brought-you-here', storage).id, first.id);
  assert.equal(guestEntryFor('Orientation#what-brought-you-here', storage).noteTitle, 'What brought you here?');
});

test('a claimed entry is bound to its account and hidden from the guest view', () => {
  const storage = memoryStorage();
  const entry = upsertGuestEntry(
    { noteId: 'Orientation#what-brought-you-here', noteTitle: 'What brought you here?', reflection: 'Mine.' },
    { storage, now: () => new Date('2026-11-22T10:00:00Z') },
  );

  const claimed = claimGuestEntry(entry.id, 'account-a', storage);
  assert.equal(claimed.accountId, 'account-a', 'a claim binds the entry to the account before import');
  assert.equal(readGuestEntries(storage)[0].accountId, 'account-a');
  // The guest view must never reveal another account's response.
  assert.equal(guestEntryFor('Orientation#what-brought-you-here', storage), null);
  // The signed-out account list excludes claimed entries too.
  assert.deepEqual(readGuestEntries(storage).filter((value) => !value.accountId), []);

  // Claiming again for the same account is idempotent and keeps the binding.
  assert.equal(claimGuestEntry(entry.id, 'account-a', storage).accountId, 'account-a');
  assert.equal(readGuestEntries(storage).length, 1);
});

test('a claim refuses another account, a missing entry and a missing account', () => {
  const storage = memoryStorage();
  const entry = upsertGuestEntry({ noteId: 'Breath', noteTitle: 'Breath', reflection: 'Keep.' }, { storage });
  assert.equal(claimGuestEntry(entry.id, 'account-a', storage).accountId, 'account-a');

  assert.equal(claimGuestEntry(entry.id, 'account-b', storage), null,
    'a bound entry belongs to the account that claimed it');
  assert.equal(readGuestEntries(storage)[0].accountId, 'account-a', 'a refused claim changes nothing');
  assert.equal(claimGuestEntry('missing', 'account-a', storage), null);
  assert.equal(claimGuestEntry(entry.id, null, storage), null);
  assert.equal(guestEntryFor('Breath', storage), null, 'the claimed entry stays hidden');
});

test('a refused claim leaves the stored entry untouched', () => {
  const storage = memoryStorage();
  const entry = upsertGuestEntry({ noteId: 'Breath', noteTitle: 'Breath', reflection: 'Mine.' }, { storage });
  // Reads succeed; only the write is refused.
  const refused = { getItem: (key) => storage.getItem(key), setItem: () => { throw new Error('blocked'); } };

  assert.equal(claimGuestEntry(entry.id, 'account-a', refused), null,
    'a storage that cannot write cannot bind the entry');
  assert.equal(readGuestEntries(storage)[0].accountId, undefined, 'the stored entry is untouched');
  assert.equal(guestEntryFor('Breath', storage).reflection, 'Mine.');
});

test('upserting a slot never overwrites a claimed entry for another account', () => {
  const storage = memoryStorage();
  const entry = upsertGuestEntry(
    { noteId: 'Breath', noteTitle: 'Breath', reflection: 'Claimed.' },
    { storage, now: () => new Date('2026-11-22T10:00:00Z') },
  );
  claimGuestEntry(entry.id, 'account-a', storage);

  const fresh = upsertGuestEntry(
    { noteId: 'Breath', noteTitle: 'Breath', reflection: 'A new answer.' },
    { storage, now: () => new Date('2026-11-22T11:00:00Z') },
  );
  assert.notEqual(fresh.id, entry.id, 'a claimed entry is not the one to edit');
  assert.equal(fresh.accountId, undefined, 'the new entry is unclaimed');

  const entries = readGuestEntries(storage);
  assert.equal(entries.length, 2);
  const bound = entries.find((value) => value.id === entry.id);
  assert.equal(bound.accountId, 'account-a');
  assert.equal(bound.reflection, 'Claimed.', 'the claimed entry keeps its own words');
  assert.equal(guestEntryFor('Breath', storage).id, fresh.id);
});

test('junk in storage is ignored without throwing', () => {
  const storage = memoryStorage();
  storage.setItem(GUEST_KEY, '{not json');
  assert.deepEqual(readGuestEntries(storage), []);
  storage.setItem(GUEST_KEY, JSON.stringify([{ nope: true }]));
  assert.deepEqual(readGuestEntries(storage), []);
});
