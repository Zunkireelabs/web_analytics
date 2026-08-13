// The source of truth for "what is a legitimate producer of agent_fix_memory
// rows", and therefore for what the obsolete-lesson sweep is allowed to
// retire.
//
// WHY THIS IS A HAND-DECLARED LIST AND NOT DERIVED FROM CODE
//
// The obvious implementation — "a lesson is obsolete if its generator_id is
// not in generators/registry.js" — is wrong, and provably so against live
// data. Two independent reasons, both real rather than hypothetical:
//
//   1. Not every producer is a generator. design-drift.js's
//      recordRejectedTemplateLesson writes
//      generator_id = 'design-agent-component-templates' every time the
//      Design Agent derives a component template that fails its placeholder
//      contract. That is a first-class, actively-written lesson type — it is
//      how the Design Agent learns not to repeat a bad derivation — and
//      registry.js has never listed it, because it is not a generator.
//
//   2. A producer can be absent from the CODE YOU ARE LOOKING AT and still be
//      actively writing in production. recordRejectedTemplateLesson does not
//      exist on the stage line at all; it lives on the unmerged Design Agent
//      branch. Its lessons are nonetheless already in the shared database. A
//      sweep run from a checkout that lacks that file would derive a producer
//      list missing it and delete real, in-use Design Agent memory.
//
// So obsolescence is defined POSITIVELY: a lesson is obsolete only when its
// producer is EXPLICITLY declared retired below. An unrecognised producer is
// never obsolete — it is reported for a human to classify. Absence of
// evidence that a producer is valid is not evidence that it isn't, and this
// table's whole job is to keep those two apart. Same "refuses rather than
// guesses" discipline the exact-match injectors and the rendering gate
// already follow.

// Producers that are NOT generator ids. Declared individually because each is
// a deliberate, known lesson type rather than something to infer.
export const NON_GENERATOR_PRODUCERS = {
  'design-agent-component-templates': {
    kind: 'design-agent',
    status: 'active',
    writtenBy: 'server/implementers/lib/design-drift.js (recordRejectedTemplateLesson)',
    description:
      'Design Agent derived a component template missing a required placeholder. Required for the autonomous '
      + 'Design Agent + generator workflow: it is how a bad derivation is remembered instead of repeated.',
  },
};

// Producers deliberately retired. A lesson whose producer appears HERE — and
// only here — is what the sweep may deprecate.
//
// Empty today, which is the honest state: nothing in this codebase has been
// retired yet, so the sweep currently retires nothing. That is the correct
// outcome, not a missing feature. To retire one, add it with a real reason
// and a date; the sweep then picks it up with no other change.
//
//   'some-removed-generator': { retiredAt: '2026-09-01', reason: 'Generator deleted in #123.' },
export const RETIRED_PRODUCERS = {};

// generator_id = NULL is a legitimate, deliberate shape, never an orphan:
//   - category='code', scope='repo'  — engineering lessons from
//     extract-branch-lesson.js / backfill-engineering-lessons.js
//   - structural/architectural lessons that apply across every generator
//     (see audit-url-file-map.js's note on this convention)
// The sweep must never touch these, so they short-circuit before any other
// check.
export const NULL_PRODUCER = '(null)';

/**
 * 'active'   — a known, currently-writing producer. Never swept.
 * 'retired'  — explicitly declared dead above. The ONLY sweepable state.
 * 'unknown'  — not recognised. Never swept; surfaced for classification.
 *
 * `knownGeneratorIds` (from generators/registry.js) is accepted as an
 * ADDITIONAL source of "active", never as a source of "retired" — that
 * asymmetry is the entire point of this module.
 */
export function producerStatus(generatorId, knownGeneratorIds = []) {
  if (generatorId == null) return 'active';
  if (RETIRED_PRODUCERS[generatorId]) return 'retired';
  if (NON_GENERATOR_PRODUCERS[generatorId]?.status === 'active') return 'active';
  if (knownGeneratorIds.includes(generatorId)) return 'active';
  return 'unknown';
}

// The single predicate the sweep asks. Returns a reason on every path so a
// caller can log WHY a row was kept, not just that it was.
export function classifyForSweep(row, knownGeneratorIds = []) {
  const status = producerStatus(row?.generator_id, knownGeneratorIds);
  if (status === 'retired') {
    const entry = RETIRED_PRODUCERS[row.generator_id];
    return { obsolete: true, status, reason: entry?.reason || `Producer "${row.generator_id}" is declared retired.` };
  }
  if (status === 'unknown') {
    return {
      obsolete: false,
      status,
      reason: `Producer "${row.generator_id}" is not recognised. NOT retired — an unrecognised producer may be a `
        + 'lesson type defined on another branch or a non-generator producer. Declare it in lesson-producers.js.',
    };
  }
  return { obsolete: false, status, reason: 'Producer is active.' };
}

// Every active producer id this module knows by name, for operator display.
export function listDeclaredProducers() {
  return [
    ...Object.entries(NON_GENERATOR_PRODUCERS).map(([id, v]) => ({ id, ...v })),
    ...Object.entries(RETIRED_PRODUCERS).map(([id, v]) => ({ id, kind: 'retired', status: 'retired', ...v })),
  ];
}
