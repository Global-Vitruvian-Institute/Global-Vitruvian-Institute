/**
 * Anonymous activity log.
 *
 * A signed-out reader can mark an activity done without creating an account.
 * Entries stay in this browser until the reader signs in, when they are moved
 * into the account's portfolio. No files: evidence needs an
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
  // A missing storage object is a refusal, not a success: the caller must be
  // able to tell the reader that nothing was kept.
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(GUEST_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
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

/**
 * Add or replace the single anonymous reflection for one note/activity slot.
 * Editing a response updates the entry already stored for that note, so saving
 * an unchanged response again never appends a duplicate. Same 50-entry cap and
 * length limit as `addGuestEntry`.
 */
export function upsertGuestEntry({ noteId, noteTitle, reflection }, { storage = safeStorage(), now = () => new Date() } = {}) {
  const trimmed = String(reflection ?? '').trim();
  if (!noteId || !trimmed) return null;
  const key = String(noteId);
  const entries = readGuestEntries(storage);
  const index = entries.findIndex((entry) => entry.noteId === key && !entry.accountId);
  const existing = index >= 0 ? entries[index] : null;
  const entry = {
    id: existing?.id ?? `guest-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    noteId: key,
    noteTitle: String(noteTitle || existing?.noteTitle || key),
    reflection: trimmed.slice(0, DEMO_LIMITS.maxReflectionLength),
    at: now().toISOString(),
  };
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  return writeGuestEntries(entries, storage) ? entry : null;
}

export function removeGuestEntries(ids, storage = safeStorage()) {
  const drop = new Set(ids);
  const entries = readGuestEntries(storage).filter((entry) => !drop.has(entry.id));
  return writeGuestEntries(entries, storage);
}

/** Bind an import before sending it, so failed cleanup cannot share it with a later account. */
export function claimGuestEntry(id, accountId, storage = safeStorage()) {
  const entries = readGuestEntries(storage);
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0 || !accountId) return null;
  const current = entries[index];
  if (current.accountId && current.accountId !== accountId) return null;
  const claimed = { ...current, accountId };
  entries[index] = claimed;
  return writeGuestEntries(entries, storage) ? claimed : null;
}

export function guestEntryFor(noteId, storage = safeStorage()) {
  return readGuestEntries(storage).find((entry) => entry.noteId === noteId && !entry.accountId) ?? null;
}
