import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_KEY,
  addGuestEntry,
  guestEntryFor,
  readGuestEntries,
  removeGuestEntries,
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

test('junk in storage is ignored without throwing', () => {
  const storage = memoryStorage();
  storage.setItem(GUEST_KEY, '{not json');
  assert.deepEqual(readGuestEntries(storage), []);
  storage.setItem(GUEST_KEY, JSON.stringify([{ nope: true }]));
  assert.deepEqual(readGuestEntries(storage), []);
});
