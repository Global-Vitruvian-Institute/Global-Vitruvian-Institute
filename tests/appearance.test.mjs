/**
 * The built-in light appearances and the one browser-local preference.
 *
 * `appearance.js` touches only the root element and `localStorage`, both of
 * which are passed in here, so every rule — validation, persistence, and what
 * happens when storage is refused — is tested without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_ATTRIBUTE,
  APPEARANCE_DEFAULT,
  APPEARANCE_KEY,
  APPEARANCES,
  appearanceLabel,
  applyAppearance,
  currentAppearance,
  initAppearance,
  isAppearanceId,
  normalizeAppearanceId,
  readStoredAppearance,
  safeStorage,
  setAppearance,
  writeStoredAppearance,
} from '../reader/public/appearance.js';

/** A root element stand-in that records what was set on it. */
function fakeRoot() {
  return {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}

/** A working, isolated `localStorage` stand-in. */
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

function throwingStorage() {
  return {
    getItem() {
      throw new DOMException('storage is blocked', 'SecurityError');
    },
    setItem() {
      throw new DOMException('storage is full', 'QuotaExceededError');
    },
  };
}

test('there are six built-in light templates, and clear is the default', () => {
  assert.deepEqual(APPEARANCES.map((preset) => preset.id), ['clear', 'paper', 'lilac', 'minimal', 'things', 'blue-topaz']);
  assert.equal(APPEARANCE_DEFAULT, 'clear');
  assert.equal(APPEARANCE_ATTRIBUTE, 'data-appearance');
  assert.equal(APPEARANCE_KEY, 'vitruvian.appearance');
  for (const preset of APPEARANCES) {
    assert.equal(typeof preset.label, 'string');
    assert.ok(preset.label.length > 0);
    assert.equal(typeof preset.description, 'string');
    assert.ok(preset.description.length > 0);
  }
});

test('only an exact known id is accepted; everything else is the default', () => {
  for (const preset of APPEARANCES) {
    assert.equal(isAppearanceId(preset.id), true);
    assert.equal(normalizeAppearanceId(preset.id), preset.id);
  }
  for (const value of [null, undefined, '', 'CLEAR', 'dark', 'Clear ', 0, {}, [], 'paper\n']) {
    assert.equal(isAppearanceId(value), false, `${JSON.stringify(value)} is not a preset`);
    assert.equal(normalizeAppearanceId(value), APPEARANCE_DEFAULT);
  }
  assert.equal(appearanceLabel('paper'), 'Paper');
  assert.equal(appearanceLabel('nonsense'), 'Clear');
});

test('a stored preference is read back, and junk is ignored', () => {
  assert.equal(readStoredAppearance(fakeStorage({ [APPEARANCE_KEY]: 'lilac' })), 'lilac');
  assert.equal(readStoredAppearance(fakeStorage({ [APPEARANCE_KEY]: 'paper' })), 'paper');
  assert.equal(readStoredAppearance(fakeStorage()), APPEARANCE_DEFAULT);
  // A value someone edited by hand must not reach the stylesheet.
  assert.equal(readStoredAppearance(fakeStorage({ [APPEARANCE_KEY]: 'dark' })), APPEARANCE_DEFAULT);
  assert.equal(readStoredAppearance(fakeStorage({ [APPEARANCE_KEY]: '' })), APPEARANCE_DEFAULT);
  assert.equal(readStoredAppearance(null), APPEARANCE_DEFAULT);
});

test('reading storage can itself throw, and that is not fatal', () => {
  assert.equal(readStoredAppearance(throwingStorage()), APPEARANCE_DEFAULT);
  // Even *accessing* localStorage can throw (blocked cookies, a sandboxed frame).
  const scope = {};
  Object.defineProperty(scope, 'localStorage', {
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
  assert.equal(safeStorage(scope), null);
  assert.equal(readStoredAppearance(safeStorage(scope)), APPEARANCE_DEFAULT);
  assert.equal(safeStorage({}), null);
});

test('a preference is persisted only when the browser allows it', () => {
  const storage = fakeStorage();
  assert.equal(writeStoredAppearance('paper', storage), true);
  assert.equal(storage.data[APPEARANCE_KEY], 'paper');
  assert.equal(readStoredAppearance(storage), 'paper');

  // An unknown id is never written, so a bad caller cannot poison the key.
  assert.equal(writeStoredAppearance('dark', storage), false);
  assert.equal(storage.data[APPEARANCE_KEY], 'paper');

  assert.equal(writeStoredAppearance('paper', null), false);
  assert.equal(writeStoredAppearance('paper', {}), false);
  assert.equal(writeStoredAppearance('paper', throwingStorage()), false);
});

test('applying a preset puts it on the root element and remembers it in memory', () => {
  const root = fakeRoot();
  assert.equal(applyAppearance('paper', root), 'paper');
  assert.equal(root.attributes[APPEARANCE_ATTRIBUTE], 'paper');
  assert.equal(currentAppearance(), 'paper');

  // An unknown id applies the default rather than writing junk.
  assert.equal(applyAppearance('dark', root), APPEARANCE_DEFAULT);
  assert.equal(root.attributes[APPEARANCE_ATTRIBUTE], APPEARANCE_DEFAULT);

  // A root that refuses attributes still leaves the in-memory choice.
  const hostile = {
    setAttribute() {
      throw new Error('no');
    },
  };
  assert.equal(applyAppearance('lilac', hostile), 'lilac');
  assert.equal(currentAppearance(), 'lilac');
});

test('initAppearance applies whatever was stored', () => {
  const root = fakeRoot();
  assert.equal(initAppearance(root, fakeStorage({ [APPEARANCE_KEY]: 'lilac' })), 'lilac');
  assert.equal(root.attributes[APPEARANCE_ATTRIBUTE], 'lilac');
  assert.equal(initAppearance(fakeRoot(), fakeStorage()), APPEARANCE_DEFAULT);
});

test('setAppearance always applies, and reports whether it could be remembered', () => {
  const root = fakeRoot();
  const storage = fakeStorage();

  const saved = setAppearance('paper', { root, storage });
  assert.deepEqual(saved, { id: 'paper', stored: true });
  assert.equal(root.attributes[APPEARANCE_ATTRIBUTE], 'paper');

  // Storage refused: the appearance still changes for this visit, and the
  // caller is told plainly rather than silently losing the choice.
  const refused = setAppearance('lilac', { root, storage: throwingStorage() });
  assert.deepEqual(refused, { id: 'lilac', stored: false });
  assert.equal(root.attributes[APPEARANCE_ATTRIBUTE], 'lilac');
  assert.equal(currentAppearance(), 'lilac');
  // The refused write left the earlier preference alone.
  assert.equal(readStoredAppearance(storage), 'paper');
});
