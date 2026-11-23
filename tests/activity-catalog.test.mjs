/**
 * The activity catalog: the five subjects, the four formats, the explicit note
 * mappings, and the two pure summaries built from them.
 *
 * The point of these tests is the boundary: a catalogued note gets its authored
 * subject and format, and anything else is neutral — never guessed from a title
 * or a reflection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_CATALOG,
  ACTIVITY_FORMATS,
  FORMAT_IDS,
  GENERAL_SUBJECT,
  SUBJECTS,
  SUBJECT_IDS,
  UNCLASSIFIED_FORMAT,
  activityMetadata,
  isNoteId,
  normalizeNoteId,
  summarizeActivities,
} from '../reader/public/activity-catalog.js';

test('the five existing subjects are registered once, with vault note ids', () => {
  assert.deepEqual(SUBJECT_IDS, ['physical', 'mental', 'intellectual', 'financial', 'social']);
  for (const id of SUBJECT_IDS) {
    const subject = SUBJECTS[id];
    assert.equal(subject.id, id);
    assert.equal(typeof subject.label, 'string');
    assert.ok(subject.label.length > 0 && subject.label.length <= 14, `${id} has a short label`);
    assert.equal(typeof subject.noteId, 'string');
    assert.ok(subject.noteId.length > 0, `${id} names a vault note`);
    assert.equal(subject.colorKey, id);
  }
  // The vault file is spelled `Intillectual`; the label is the natural one.
  assert.equal(SUBJECTS.intellectual.label, 'Intellectual');
  assert.equal(SUBJECTS.intellectual.noteId, 'Intillectual');
  assert.equal(SUBJECTS.physical.noteId, 'Physical wellness');
  assert.equal(SUBJECTS.mental.noteId, 'Mental Health');
  assert.equal(SUBJECTS.financial.noteId, 'financial wellness');
  assert.equal(SUBJECTS.social.noteId, 'social skills');
});

test('the four formats are registered in order', () => {
  assert.deepEqual(FORMAT_IDS, ['reflection', 'writing', 'practice', 'project']);
  assert.equal(ACTIVITY_FORMATS.reflection.label, 'Reflection');
  assert.equal(ACTIVITY_FORMATS.writing.label, 'Writing');
  assert.equal(ACTIVITY_FORMATS.practice.label, 'Practice');
  assert.equal(ACTIVITY_FORMATS.project.label, 'Project');
});

test('the catalog maps the four existing activities explicitly', () => {
  assert.deepEqual(ACTIVITY_CATALOG.Movement, { subjectId: 'physical', formatId: 'practice' });
  assert.deepEqual(ACTIVITY_CATALOG['Money check-in'], { subjectId: 'financial', formatId: 'writing' });
  assert.deepEqual(ACTIVITY_CATALOG['Orientation#what-brought-you-here'], {
    subjectId: null, formatId: 'reflection',
  });
  // Breath is physical first, with an optional mental badge that never counts.
  assert.equal(ACTIVITY_CATALOG.Breath.subjectId, 'physical');
  assert.equal(ACTIVITY_CATALOG.Breath.secondarySubjectId, 'mental');
  assert.equal(ACTIVITY_CATALOG.Breath.formatId, 'practice');
});

test('activityMetadata returns registry labels and colour keys', () => {
  const movement = activityMetadata('Movement');
  assert.equal(movement.known, true);
  assert.equal(movement.subjectKnown, true);
  assert.equal(movement.subjectId, 'physical');
  assert.equal(movement.subjectLabel, 'Physical');
  assert.equal(movement.colorKey, 'physical');
  assert.equal(movement.formatId, 'practice');
  assert.equal(movement.formatLabel, 'Practice');

  const money = activityMetadata('Money check-in');
  assert.equal(money.subjectId, 'financial');
  assert.equal(money.formatId, 'writing');

  const orientation = activityMetadata('Orientation#what-brought-you-here');
  assert.equal(orientation.known, true);
  assert.equal(orientation.subjectKnown, false);
  assert.equal(orientation.subjectId, GENERAL_SUBJECT.id);
  assert.equal(orientation.colorKey, 'neutral');
  assert.equal(orientation.formatId, 'reflection');
});

test('Breath carries a secondary mental badge but a single primary subject', () => {
  const breath = activityMetadata('Breath');
  assert.equal(breath.subjectId, 'physical');
  assert.equal(breath.secondarySubjectId, 'mental');
  assert.equal(breath.secondarySubjectLabel, 'Mental');
  assert.equal(breath.formatId, 'practice');
});

test('an unknown record is neutral and unclassified, never guessed', () => {
  const unknown = activityMetadata('Some New Note');
  assert.equal(unknown.known, false);
  assert.equal(unknown.subjectId, GENERAL_SUBJECT.id);
  assert.equal(unknown.subjectLabel, 'General');
  assert.equal(unknown.colorKey, 'neutral');
  assert.equal(unknown.formatId, UNCLASSIFIED_FORMAT.id);
  assert.equal(unknown.formatLabel, 'Unclassified');
  // The note that contains the inline activity is not itself an activity.
  assert.equal(activityMetadata('Orientation').known, false);
  assert.equal(activityMetadata('Orientation').subjectId, 'general');
  assert.equal(activityMetadata('').known, false);
  assert.equal(activityMetadata(undefined).known, false);
  assert.equal(activityMetadata(42).known, false);
});

test('metadata reads the note id only, never a reflection or title', () => {
  const a = activityMetadata('Movement');
  const b = activityMetadata('Movement');
  assert.deepEqual(a, b);
  // A reflection that names money or effort cannot move the subject.
  const record = { id: 'x', noteId: 'Unknown', noteTitle: 'Money check-in', reflection: 'I ran 10km and spent £40' };
  const summary = summarizeActivities([record]);
  assert.equal(summary.items[0].subjectId, 'general');
  assert.equal(summary.items[0].formatId, 'unclassified');
});

test('isNoteId and normalizeNoteId accept only real ids', () => {
  assert.equal(isNoteId('Movement'), true);
  assert.equal(isNoteId('  '), false);
  assert.equal(isNoteId(null), false);
  assert.equal(normalizeNoteId('  Movement  '), 'Movement');
  assert.equal(normalizeNoteId('   '), '');
});

test('summarizeActivities deduplicates by stable record id only', () => {
  const records = [
    { id: 'a', noteId: 'Movement', reflection: 'first' },
    { id: 'a', noteId: 'Movement', reflection: 'a different reflection' },
    { id: 'b', noteId: 'Money check-in' },
    { id: 'b', noteId: 'Money check-in' },
    { id: 'c', noteId: 'Money check-in' },
  ];
  const summary = summarizeActivities(records);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySubject.physical, 1);
  assert.equal(summary.bySubject.financial, 2);
  assert.equal(summary.byFormat.practice, 1);
  assert.equal(summary.byFormat.writing, 2);
});

test('records without an id are counted separately, never merged', () => {
  const summary = summarizeActivities([
    { noteId: 'Movement' },
    { noteId: 'Movement' },
    { id: '', noteId: 'Movement' },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySubject.physical, 3);
});

test('summarizeActivities counts every subject and format, zeros included', () => {
  const summary = summarizeActivities([{ id: 'a', noteId: 'Movement' }]);
  for (const id of [...SUBJECT_IDS, GENERAL_SUBJECT.id]) {
    assert.equal(typeof summary.bySubject[id], 'number', `${id} is counted`);
  }
  for (const id of [...FORMAT_IDS, UNCLASSIFIED_FORMAT.id]) {
    assert.equal(typeof summary.byFormat[id], 'number', `${id} is counted`);
  }
  assert.equal(summary.bySubject.mental, 0);
  assert.equal(summary.bySubject.social, 0);
  assert.equal(summary.byFormat.project, 0);
});

test('an unknown record is general and unclassified in the summary', () => {
  const summary = summarizeActivities([
    { id: 'a', noteId: 'Mystery' },
    { id: 'b', noteId: 'Orientation#what-brought-you-here' },
  ]);
  assert.equal(summary.bySubject.general, 2);
  assert.equal(summary.byFormat.unclassified, 1);
  assert.equal(summary.byFormat.reflection, 1);
});

test('the summary is counts only: no goals, score, percentages or ranking', () => {
  const summary = summarizeActivities([{ id: 'a', noteId: 'Movement' }, { id: 'b', noteId: 'Mystery' }]);
  assert.deepEqual(Object.keys(summary).sort(), ['byFormat', 'bySubject', 'items', 'total']);
  const serialised = JSON.stringify(summary).toLowerCase();
  for (const forbidden of ['goal', 'percent', 'score', 'complete', 'rank', 'weight', 'effort']) {
    assert.equal(serialised.includes(forbidden), false, `summary must not contain "${forbidden}"`);
  }
  assert.equal(summary.total, 2);
  assert.equal(summary.items.length, 2);
});

test('summarizeActivities tolerates an empty or invalid list', () => {
  assert.equal(summarizeActivities().total, 0);
  assert.equal(summarizeActivities(null).total, 0);
  assert.equal(summarizeActivities([null, 'x', 3]).total, 0);
});
