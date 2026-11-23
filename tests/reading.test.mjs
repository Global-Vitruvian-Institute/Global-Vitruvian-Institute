/**
 * Reading modes and their one browser-local preference.
 *
 * `reading.js` touches only the root element and `localStorage`, both supplied
 * here, so validation, persistence and refused storage are tested without a
 * browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READING_ATTRIBUTE,
  READING_DEFAULT,
  READING_KEY,
  READING_MODES,
  applyReadingMode,
  currentReadingMode,
  initReadingMode,
  isReadingMode,
  normalizeReadingMode,
  readStoredReadingMode,
  setReadingMode,
  writeStoredReadingMode,
} from '../reader/public/reading.js';

function fakeRoot() {
  return {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

test('page is the default, stacked is the advanced mode', () => {
  assert.equal(READING_DEFAULT, 'page');
  assert.equal(READING_ATTRIBUTE, 'data-reading');
  assert.equal(READING_KEY, 'vitruvian.reading');
  assert.deepEqual(READING_MODES.map((mode) => mode.id), ['page', 'stacked']);
  for (const mode of READING_MODES) assert.ok(mode.label && mode.description);
});

test('only exact known modes are accepted', () => {
  for (const value of [null, undefined, '', 'PAGE', 'tabs', 'page ', 0, {}]) {
    assert.equal(isReadingMode(value), false);
    assert.equal(normalizeReadingMode(value), 'page');
  }
  assert.equal(normalizeReadingMode('stacked'), 'stacked');
});

test('a stored mode is read back, junk falls back to page, refused storage is not fatal', () => {
  assert.equal(readStoredReadingMode(fakeStorage({ [READING_KEY]: 'stacked' })), 'stacked');
  assert.equal(readStoredReadingMode(fakeStorage({ [READING_KEY]: 'junk' })), 'page');
  assert.equal(readStoredReadingMode({ getItem() { throw new Error('blocked'); } }), 'page');
  assert.equal(writeStoredReadingMode('stacked', fakeStorage()), true);
  assert.equal(writeStoredReadingMode('junk', fakeStorage()), false);
  assert.equal(writeStoredReadingMode('stacked', { setItem() { throw new Error('full'); } }), false);
});

test('applying a mode sets the root attribute, and a change reports whether it was stored', () => {
  const root = fakeRoot();
  const storage = fakeStorage();
  assert.equal(applyReadingMode('stacked', root), 'stacked');
  assert.equal(root.attributes[READING_ATTRIBUTE], 'stacked');
  assert.equal(currentReadingMode(), 'stacked');
  const result = setReadingMode('page', { root, storage });
  assert.deepEqual(result, { id: 'page', stored: true });
  assert.equal(storage.data[READING_KEY], 'page');
  assert.equal(root.attributes[READING_ATTRIBUTE], 'page');
});

test('init applies the stored choice', () => {
  const root = fakeRoot();
  assert.equal(initReadingMode(root, fakeStorage({ [READING_KEY]: 'stacked' })), 'stacked');
  assert.equal(root.attributes[READING_ATTRIBUTE], 'stacked');
});
