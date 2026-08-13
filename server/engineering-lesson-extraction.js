import { callLLMForJson } from './llm.js';

// Shared classify/extract logic for code-bug lessons — stored as
// category='code', scope='repo' rows in agent_fix_memory (migration 097).
// (This used to target the standalone engineering_fix_lessons table, 087,
// which f40fa76 consolidated away; that table is now dead.)
// Used by both server/scripts/backfill-engineering-lessons.js (one-time, walks
// full git history) and server/scripts/extract-branch-lesson.js (ongoing,
// runs against a single fix/* branch's diff before its PR is created) — one
// implementation, so the extraction quality/wording is identical whichever
// caller invokes it.

export const MAX_DIFF_CHARS = 6000;

export function truncateDiff(diff) {
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)` : diff;
}

const CLASSIFY_SYSTEM = `You review a git commit or a full PR branch diff from a web application's codebase (Node/Express backend, React frontend) and decide whether it is a genuine APPLICATION CODE bug fix worth recording as a reusable engineering lesson.

Say NO (not a code bug fix) if the change is:
- A new feature or capability addition, even if it also fixes something minor as a side effect
- A pure content/copy/SEO-generator prompt fix (that is a client-facing content lesson, not a code lesson)
- A docs-only, formatting-only, or dependency-bump-only change
- A merge commit or a revert with no independent content of its own

Say YES only if the change's main purpose is fixing a real defect in this application's own source code (a crash, wrong behavior, hang, race condition, resource leak, incorrect logic, etc).

Respond with ONLY this JSON shape, no other text:
{"isCodeBugFix": true|false, "reason": "one short sentence"}`;

const EXTRACT_SYSTEM = `You are recording a generalized engineering lesson from a real bug fix in a web application codebase, for a table that future bug fixes in this same codebase will be checked against BEFORE making a similar change. The reader will never see this specific commit/diff — only your summary — so it must stand on its own as a general rule, not a description of this one file.

Given a commit message (or PR description) and diff, produce ONLY this JSON shape, no other text:
{
  "bugCategory": "short kebab-case category, e.g. hook-ordering, webhook-blocking-io, race-condition, null-pointer, off-by-one",
  "symptom": "the observable failure in plain language, as a user or operator would see it — not code terms",
  "rootCause": "one or two sentences: the actual underlying reason, generalized past this one file",
  "fixPattern": "a generalized RULE for how to avoid or fix this class of bug in future code — describe the pattern, never paste or closely paraphrase the actual diff/code",
  "appliesTo": "a short file/module pattern this generalizes to, e.g. 'React components with early-return guards before hooks', '*webhook*.js handlers doing synchronous work', 'Express routes calling external APIs without a timeout'"
}

If the diff does not contain enough information to state a real generalized rule, respond with {"bugCategory": null} instead.`;

export async function classifyBugFix({ message, diff }) {
  const user = `Commit/PR message:\n${message}\n\nDiff:\n${truncateDiff(diff)}`;
  return callLLMForJson(CLASSIFY_SYSTEM, user, { maxTokens: 150 });
}

export async function extractLesson({ message, diff }) {
  const user = `Commit/PR message:\n${message}\n\nDiff:\n${truncateDiff(diff)}`;
  return callLLMForJson(EXTRACT_SYSTEM, user, { maxTokens: 500 });
}

const CONSOLIDATE_SYSTEM = `You are given several draft engineering-lesson entries extracted independently from different git commits, all sharing the same rough bug_category label. Some of them describe the SAME underlying bug pattern in different words (e.g. two different phrasings of "merge conflicts leave broken JSX"); others are genuinely different bugs that just got the same category label.

Group them by actual underlying meaning, not by surface wording. For each group, produce ONE merged canonical lesson using the clearest, most general wording from among the drafts (do not just concatenate all of them together). Every draft's "ref" value must appear in exactly one output group's "refs" array — do not drop any.

Respond with ONLY this JSON shape, no other text:
{"groups": [
  {
    "bugCategory": "short kebab-case category",
    "symptom": "...",
    "rootCause": "...",
    "fixPattern": "...",
    "appliesTo": "...",
    "refs": ["<ref>", "<ref>", ...]
  }
]}`;

const DEDUP_SYSTEM = `You are given ONE newly-extracted engineering lesson and a list of EXISTING lessons that already share the same bug_category label. Decide whether the new lesson describes the SAME underlying bug pattern as one of the existing ones (just possibly worded differently), or is a genuinely different bug that happens to share the category label.

Respond with ONLY this JSON shape, no other text:
{
  "duplicateOfId": <id of the matching existing lesson, or null if none match>,
  "mergedSymptom": "clearest combined wording, or empty string if duplicateOfId is null",
  "mergedRootCause": "clearest combined wording, or empty string if duplicateOfId is null",
  "mergedFixPattern": "clearest combined wording, or empty string if duplicateOfId is null",
  "mergedAppliesTo": "clearest combined wording, or empty string if duplicateOfId is null"
}

Merged wording should be the clearest, most general version covering both lessons — not a concatenation of both.`;

// Checks a newly-extracted lesson against existing lessons sharing the same
// bug_category (exact match, case-insensitive) — the ongoing per-PR insert
// path's counterpart to consolidateDrafts() above, but for one new lesson
// against already-committed rows instead of a batch of fresh drafts. Used
// because plain substring matching on applies_to (findSimilarLesson in
// engineering-lessons.js) missed a real duplicate in testing: two separate
// extraction runs on the same underlying webhook-timeout bug produced
// wording with no substring overlap. No LLM call if there are no
// same-category candidates at all — cheap common case stays cheap.
export async function findDuplicateLesson(newLesson, existingLessons) {
  const candidates = existingLessons.filter((l) => l.bug_category.toLowerCase() === newLesson.bugCategory.toLowerCase());
  if (!candidates.length) return null;

  const user = JSON.stringify({
    new: { bugCategory: newLesson.bugCategory, symptom: newLesson.symptom, rootCause: newLesson.rootCause, fixPattern: newLesson.fixPattern, appliesTo: newLesson.appliesTo },
    existing: candidates.map((c) => ({ id: c.id, symptom: c.symptom, rootCause: c.root_cause, fixPattern: c.fix_pattern, appliesTo: c.applies_to })),
  });
  const result = await callLLMForJson(DEDUP_SYSTEM, user, { maxTokens: 400 });
  if (result.duplicateOfId == null) return null;

  const match = candidates.find((c) => c.id === result.duplicateOfId);
  if (!match) return null; // model hallucinated an id — treat as no match rather than crash
  return {
    existingLesson: match,
    merged: {
      symptom: result.mergedSymptom || match.symptom,
      rootCause: result.mergedRootCause || match.root_cause,
      fixPattern: result.mergedFixPattern || match.fix_pattern,
      appliesTo: result.mergedAppliesTo || match.applies_to,
    },
  };
}

// Only used by the backfill script (a single branch's diff yields at most one
// draft, so there's nothing to consolidate there) — kept here anyway so both
// callers share the exact same prompt/shape if that ever changes.
export async function consolidateDrafts(drafts) {
  const byCategory = new Map();
  for (const d of drafts) {
    const key = d.bugCategory.toLowerCase();
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(d);
  }

  const canonical = [];
  for (const [, group] of byCategory) {
    if (group.length === 1) {
      const d = group[0];
      canonical.push({ ...d, refs: [d.ref] });
      continue;
    }
    const user = JSON.stringify(group.map((d) => ({
      ref: d.ref,
      bugCategory: d.bugCategory,
      symptom: d.symptom,
      rootCause: d.rootCause,
      fixPattern: d.fixPattern,
      appliesTo: d.appliesTo,
    })));
    let result;
    try {
      result = await callLLMForJson(CONSOLIDATE_SYSTEM, user, { maxTokens: 1200 });
    } catch (err) {
      console.warn(`Consolidation failed for category group (${group.length} drafts), keeping them unmerged: ${err.message}`);
      for (const d of group) canonical.push({ ...d, refs: [d.ref] });
      continue;
    }
    for (const g of result.groups || []) {
      canonical.push({ bugCategory: g.bugCategory, symptom: g.symptom, rootCause: g.rootCause, fixPattern: g.fixPattern, appliesTo: g.appliesTo, refs: g.refs || [] });
    }
  }
  return canonical;
}
