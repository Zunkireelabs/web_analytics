import { evaluateProgrammaticBatch } from '../../lib/programmatic-gate.js';
import { listSiblingDrafts } from '../../store/programmatic-siblings.js';

// Quality-gate check for pages made in bulk from one template. A landing page for each city or market is exactly the pattern Google's
// scaled-content policy targets when the pages differ only by a swapped name, so a new draft is compared with the site's other drafts of
// the same kind (lib/programmatic-gate.js, which measures unique wording). Mostly-template wording fails the gate with a correction,
// and generateDraft then regenerates with that feedback, the same way it repairs every other issue. A merely low-unique draft is shown
// but does not fail.
//
// Never blocks on infrastructure: if the siblings cannot be read, the check is skipped (an outage must not stop every draft).
// Batch-size limits are not repeated here: the shipping step already caps a batch (SAFE_FIX_BATCH_LIMIT) and a day's work.

export const PROGRAMMATIC_GENERATOR_IDS = new Set(['landing-page']);

// Everything a visitor reads on a landing page, as one string. Image and meta fields are left out.
export function programmaticText(content) {
  const c = content || {};
  const parts = [c.headline, c.subheadline];
  for (const s of Array.isArray(c.sections) ? c.sections : []) parts.push(s?.heading, s?.body);
  parts.push(c.cta);
  return parts.filter((p) => typeof p === 'string' && p.trim()).join('\n');
}

export async function findProgrammaticIssues(content, generatorId, siteId, { listSiblings = listSiblingDrafts } = {}) {
  if (!PROGRAMMATIC_GENERATOR_IDS.has(generatorId) || siteId == null) return [];
  const text = programmaticText(content);
  if (!text) return [];
  let siblings;
  try { siblings = await listSiblings(siteId, generatorId, { excludeTarget: content?.target ?? null }); }
  catch (err) { console.warn(`[programmatic-guard] siblings unreadable, check skipped: ${err.message}`); return []; }
  const against = siblings.map((s) => ({ id: s.id, text: programmaticText(s.content) })).filter((s) => s.text);
  if (!against.length) return []; // the first page of a family has nothing to be a copy of

  const verdict = evaluateProgrammaticBatch({ pages: [{ id: 'this', text }], against }).pages[0];
  const pct = Math.round((verdict.uniquePct ?? 1) * 100);
  const target = content?.target ? ` for "${content.target}"` : '';
  if (verdict.flags.includes('mostly-template')) {
    return [{
      path: 'sections', patternId: 'programmatic-template', blocking: true, uniquePct: pct,
      snippet: `Only ${pct}% of this page's wording is not already on the site's other landing pages.`,
      correction: `This landing page${target} repeats the wording of the site's other landing pages: only ${pct}% of it is new. Pages that differ only by a swapped name are treated by Google as scaled, low-value content. Rewrite it so that most of it is specific to this page's own topic: its own facts, examples, questions and details. Do not reuse sentences from other pages and do not just swap the name into the same text.`,
    }];
  }
  if (verdict.flags.includes('low-unique')) {
    return [{ path: 'sections', patternId: 'programmatic-low-unique', blocking: false, uniquePct: pct, snippet: `Only ${pct}% of this page's wording is not already on the site's other landing pages.` }];
  }
  return [];
}
