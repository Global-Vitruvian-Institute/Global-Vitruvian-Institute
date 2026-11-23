/**
 * Anonymous activity log.
 *
 * A signed-out reader can mark an activity done without creating an account.
 * Entries stay in this browser until the reader signs in, when the account view
 * offers to move them into the real portfolio. No files: evidence needs an
 * account, and localStorage is the wrong place for bytes.
 */
import { DEMO_LIMITS } from './demo-model.js';

export const GUEST_KEY = 'vitruvian.guest-activities';
const MAX_ENTRIES = 50;

function safeStorage(scope = globalThis) {
  try {
    return scope?.localStorage ?? null;
  } catch {
    return null;
  }
}

function validEntry(value) {
  return value
    && typeof value.id === 'string'
    && typeof value.noteId === 'string'
    && typeof value.noteTitle === 'string'
    && typeof value.reflection === 'string'
    && typeof value.at === 'string';
}

export function readGuestEntries(storage = safeStorage()) {
  try {
    const raw = storage?.getItem?.(GUEST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(validEntry) : [];
  } catch {
    return [];
  }
}

function writeGuestEntries(entries, storage = safeStorage()) {
  try {
    storage?.setItem?.(GUEST_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}

/** Add one reflection. Empty reflections are refused; the dialog validates too. */
export function addGuestEntry({ noteId, noteTitle, reflection }, { storage = safeStorage(), now = () => new Date() } = {}) {
  const trimmed = String(reflection ?? '').trim();
  if (!noteId || !trimmed) return null;
  const entry = {
    id: `guest-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    noteId: String(noteId),
    noteTitle: String(noteTitle || noteId),
    reflection: trimmed.slice(0, DEMO_LIMITS.maxReflectionLength),
    at: now().toISOString(),
  };
  const entries = [...readGuestEntries(storage), entry];
  return writeGuestEntries(entries, storage) ? entry : null;
}

export function removeGuestEntries(ids, storage = safeStorage()) {
  const drop = new Set(ids);
  const entries = readGuestEntries(storage).filter((entry) => !drop.has(entry.id));
  return writeGuestEntries(entries, storage);
}

export function guestEntryFor(noteId, storage = safeStorage()) {
  return readGuestEntries(storage).find((entry) => entry.noteId === noteId) ?? null;
}
