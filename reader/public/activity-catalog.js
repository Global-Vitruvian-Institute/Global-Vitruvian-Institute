/**
 * activity-catalog.js — the small, authored map from a saved activity to the
 * subject and format it belongs to.
 *
 * The map is deliberately hand-written and short. Nothing here reads a
 * reflection, counts words, or guesses at effort: a record either matches a
 * catalog entry or it is neutral. That keeps the reader's own writing out of
 * any inference, and means an unrecognised note is shown as `General` with an
 * `Unclassified` format rather than being filed under whatever it resembles.
 *
 * Note ids are the stable vault ids (`Movement`, `Money check-in`, and the
 * inline activity id `Orientation#what-brought-you-here`). Titles are neither
 * stable nor unique, so they are never used as keys.
 */

/** Short, natural labels for the five subjects the guide already has. */
export const SUBJECTS = Object.freeze({
  physical: Object.freeze({
    id: 'physical', label: 'Physical', title: 'Physical wellness', noteId: 'Physical wellness', colorKey: 'physical',
  }),
  mental: Object.freeze({
    id: 'mental', label: 'Mental', title: 'Mental Health', noteId: 'Mental Health', colorKey: 'mental',
  }),
  // The vault file is spelled `Intillectual`; the note's own title is
  // `Intellectual`. Both are kept, and `noteId` is the resolvable one.
  intellectual: Object.freeze({
    id: 'intellectual', label: 'Intellectual', title: 'Intellectual', noteId: 'Intillectual', colorKey: 'intellectual',
  }),
  financial: Object.freeze({
    id: 'financial', label: 'Financial', title: 'Financial wellness', noteId: 'financial wellness', colorKey: 'financial',
  }),
  social: Object.freeze({
    id: 'social', label: 'Social', title: 'Social skills', noteId: 'social skills', colorKey: 'social',
  }),
});

/** The five subject ids, in the order the guide lists them. */
export const SUBJECT_IDS = Object.freeze(Object.keys(SUBJECTS));

/**
 * The neutral bucket. An unrecognised record lands here. It is a real,
 * countable subject so the legend can show a zero without implying a deficit.
 */
export const GENERAL_SUBJECT = Object.freeze({
  id: 'general', label: 'General', title: 'General', noteId: null, colorKey: 'neutral',
});

/** The four authored formats. A record that matches none is `Unclassified`. */
export const ACTIVITY_FORMATS = Object.freeze({
  reflection: Object.freeze({ id: 'reflection', label: 'Reflection' }),
  writing: Object.freeze({ id: 'writing', label: 'Writing' }),
  practice: Object.freeze({ id: 'practice', label: 'Practice' }),
  project: Object.freeze({ id: 'project', label: 'Project' }),
});

/** The four format ids, in registry order. */
export const FORMAT_IDS = Object.freeze(Object.keys(ACTIVITY_FORMATS));

/** The neutral format. Never inferred from what a reflection says. */
export const UNCLASSIFIED_FORMAT = Object.freeze({ id: 'unclassified', label: 'Unclassified' });

/**
 * The editable catalog. Keys are stable note ids; values name a subject
 * (or `null` for a deliberately general prompt) and a format. `secondarySubjectId`
 * is an optional second badge a note may carry — it is presentation only and
 * never changes the primary count.
 *
 * `Orientation#what-brought-you-here` is the guide's opening prompt. It belongs
 * to no one subject, so its subject is `null` and it counts as `General`.
 */
export const ACTIVITY_CATALOG = {
  Movement: { subjectId: 'physical', formatId: 'practice' },
  Breath: { subjectId: 'physical', secondarySubjectId: 'mental', formatId: 'practice' },
  'Money check-in': { subjectId: 'financial', formatId: 'writing' },
  'Orientation#what-brought-you-here': { subjectId: null, formatId: 'reflection' },
};

/** True when a value is a non-empty note id string. */
export function isNoteId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The catalog key for a record's note id: trimmed, never decoded or guessed. */
export function normalizeNoteId(noteId) {
  return isNoteId(noteId) ? noteId.trim() : '';
}

function catalogEntry(noteId) {
  const key = normalizeNoteId(noteId);
  if (!key || !Object.hasOwn(ACTIVITY_CATALOG, key)) return null;
  const entry = ACTIVITY_CATALOG[key];
  return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Normalised metadata for one note id. Always returns a complete shape: a
 * catalogued note gets its authored subject and format, and anything else gets
 * `General` / `Unclassified`. `known` says whether the catalog matched at all,
 * while `subjectKnown` says whether it named a real subject (the opening prompt
 * is catalogued but deliberately general).
 */
export function activityMetadata(noteId) {
  const key = normalizeNoteId(noteId);
  const entry = catalogEntry(key);
  const subject = entry?.subjectId && SUBJECTS[entry.subjectId]
    ? SUBJECTS[entry.subjectId]
    : GENERAL_SUBJECT;
  const secondary = entry?.secondarySubjectId && SUBJECTS[entry.secondarySubjectId]
    ? SUBJECTS[entry.secondarySubjectId]
    : null;
  const format = entry?.formatId && ACTIVITY_FORMATS[entry.formatId]
    ? ACTIVITY_FORMATS[entry.formatId]
    : UNCLASSIFIED_FORMAT;
  return {
    noteId: key,
    known: Boolean(entry),
    subjectKnown: Boolean(entry?.subjectId && SUBJECTS[entry.subjectId]),
    subjectId: subject.id,
    subjectLabel: subject.label,
    subjectNoteId: subject.noteId,
    colorKey: subject.colorKey,
    secondarySubjectId: secondary?.id ?? null,
    secondarySubjectLabel: secondary?.label ?? null,
    formatId: format.id,
    formatLabel: format.label,
  };
}

/** Zero-initialised counts for every subject, including `general`. */
function emptySubjectCounts() {
  const counts = Object.create(null);
  for (const id of SUBJECT_IDS) counts[id] = 0;
  counts[GENERAL_SUBJECT.id] = 0;
  return counts;
}

/** Zero-initialised counts for every format, including `unclassified`. */
function emptyFormatCounts() {
  const counts = Object.create(null);
  for (const id of FORMAT_IDS) counts[id] = 0;
  counts[UNCLASSIFIED_FORMAT.id] = 0;
  return counts;
}

function recordId(record) {
  const value = record?.id;
  if (typeof value === 'string' && value.length) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Count saved activities by subject and format.
 *
 * Deduplication is by stable record id and nothing else: the same id is one
 * activity no matter how many times it appears, and a record without an id is
 * never merged with another. The result is counts only — no goals, no
 * percentages, no score, no completeness and no ranking.
 */
export function summarizeActivities(records = []) {
  const list = Array.isArray(records) ? records : [];
  const seen = new Set();
  const items = [];
  const bySubject = emptySubjectCounts();
  const byFormat = emptyFormatCounts();

  for (const record of list) {
    if (!record || typeof record !== 'object') continue;
    const id = recordId(record);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const meta = activityMetadata(record.noteId);
    items.push({
      id,
      noteId: meta.noteId,
      noteTitle: typeof record.noteTitle === 'string' ? record.noteTitle : '',
      subjectId: meta.subjectId,
      subjectLabel: meta.subjectLabel,
      colorKey: meta.colorKey,
      secondarySubjectId: meta.secondarySubjectId,
      formatId: meta.formatId,
      formatLabel: meta.formatLabel,
    });
    bySubject[meta.subjectId] += 1;
    byFormat[meta.formatId] += 1;
  }

  return { total: items.length, items, bySubject, byFormat };
}
