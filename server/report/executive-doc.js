import { getDocs } from '../auth/google.js';
import { query } from '../db.js';
import { callLLM } from '../llm.js';
import { runAgent } from '../agents/runner.js';
import { previousWeek, weekOf } from '../util/dates.js';
import { weekLabel } from './weekly-doc.js';

// The Weekly AI Executive Report is NOT another metrics report — it has no
// tables of clicks/impressions. It's a narrative summary built entirely on
// top of the executive-report AGENT's already-computed, already-verified
// output (every specialist agent), so it never re-queries raw metrics or
// invents new numbers of its own.

const SECTION_KEYS = ['whatImproved', 'whatDeclined', 'whyItHappened', 'highestOpportunities', 'highestRisks', 'recommendedActions', 'estimatedImpact'];
const SECTION_LABELS = {
  whatImproved: 'What Improved',
  whatDeclined: 'What Declined',
  whyItHappened: 'Why It Happened',
  highestOpportunities: 'Highest Opportunities',
  highestRisks: 'Highest Risks',
  recommendedActions: 'Recommended Actions',
  estimatedImpact: 'Estimated Impact',
};

async function ensureDoc(site) {
  if (site.executive_doc_id) return site.executive_doc_id;
  const docs = getDocs(site);
  const res = await docs.documents.create({
    requestBody: { title: `${site.name} — AI Executive Report` },
  });
  const id = res.data.documentId;
  await query('UPDATE sites SET executive_doc_id = $1 WHERE id = $2', [id, site.id]);
  console.log(`[executive] created report doc ${id}`);
  return id;
}

// Parses the model's JSON response into the 7 fixed sections. Falls back to
// putting the raw text under the first section rather than losing it
// silently if the model didn't return valid JSON.
function parseSections(raw) {
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const out = {};
    for (const key of SECTION_KEYS) {
      out[key] = typeof parsed[key] === 'string' && parsed[key].trim() ? parsed[key].trim() : 'Not available this week.';
    }
    return out;
  } catch {
    return SECTION_KEYS.reduce((acc, key, i) => {
      acc[key] = i === 0 ? (raw || 'Report generation failed.') : 'Not available this week.';
      return acc;
    }, {});
  }
}

function buildSection(label, sections) {
  let text = '';
  const add = (s) => { text += s; };

  const headingStart = text.length;
  add(`AI Executive Report — Week of ${label}\n`);
  const heading = { start: headingStart, end: text.length - 1 };
  add('\n');

  const subheads = [];
  for (const key of SECTION_KEYS) {
    const subStart = text.length;
    add(`${SECTION_LABELS[key]}\n`);
    subheads.push({ start: subStart, end: text.length - 1 });
    add(`${sections[key]}\n\n`);
  }

  add('────────────────────────────────────────\n\n');

  return { text, heading, subheads };
}

// Generate (or regenerate) the executive section and insert it at the TOP of
// the doc. `anchorDate` (YYYY-MM-DD) picks which week; defaults to the
// previous full week — same resolution as the weekly analytics report, so
// they always cover the identical period.
export async function runExecutiveDocReport(site, anchorDate) {
  const { start, end } = anchorDate ? weekOf(anchorDate) : previousWeek(site.timezone);

  // Reuses the existing executive-report agent's full run — every specialist
  // agent's real facts — instead of re-querying any raw metrics here. This
  // also persists to agent_runs via the normal runner, same as any other
  // agent invocation.
  const agentOutput = await runAgent('executive-report', { siteId: site.id, start, end });
  const label = weekLabel(start, end);

  const digest = { week: label, site: site.name, sections: agentOutput.facts.sections };

  const system = 'You are a growth strategist writing a WEEKLY AI Executive Report for a non-technical site ' +
    'owner\'s leadership team. You are given `sections`, the real, already-computed output of seven specialist ' +
    'agents (query intelligence, opportunity, country intelligence, device intelligence, AI visibility, content ' +
    'gap, technical SEO) for this week — every number in it is real, already-verified data. Competitor ' +
    'intelligence runs on its own monthly cadence and is not included every week — never invent a competitor ' +
    'claim in its absence. Some ' +
    'sections may have status "insufficient-data" or "error" — name that plainly as a gap, never guess around it.\n\n' +
    'Return ONLY a JSON object (no prose, no markdown fences) with exactly these seven string fields, each 2-4 ' +
    'plain-text sentences (no markdown, no bullet symbols):\n' +
    '- whatImproved: real gains pulled from the given sections (gainers, growing markets, etc.)\n' +
    '- whatDeclined: real drops pulled from the given sections (droppers, declining markets, low scores, etc.)\n' +
    '- whyItHappened: state a cause ONLY if directly inferable from the given facts (a specific query/page/market ' +
    'named in the data) — if no clear cause is evident, say so plainly instead of speculating\n' +
    '- highestOpportunities: the highest-value real opportunities from the opportunity/content-gap/ai-visibility ' +
    'sections, prioritized\n' +
    '- highestRisks: risks evidenced by real declining metrics, low-CTR flags, or low AI-visibility scores in the ' +
    'given sections — never an invented business risk with no data support. Competitor intelligence is not part ' +
    'of this weekly digest (it runs monthly) — never claim a competitive threat here.\n' +
    '- recommendedActions: aggregate the specialist agents\' own already-computed recommendations for the coming ' +
    'week — do not invent new ones\n' +
    '- estimatedImpact: cite ONLY the opportunity section\'s own estimatedTrafficGain figures if present, framed ' +
    'explicitly as an estimate — never invent a revenue or dollar figure, there is no conversion-value data here.';
  const user = `Weekly executive digest:\n\n${JSON.stringify(digest)}`;
  const raw = await callLLM(system, user, { maxTokens: 1200 });
  const sections = parseSections(raw);

  const { text: sectionText, heading, subheads } = buildSection(label, sections);

  const docId = await ensureDoc(site);
  const docs = getDocs(site);
  const base = 1; // insert at top, newest week first — same convention as the weekly analytics doc
  const requests = [{ insertText: { location: { index: base }, text: sectionText } }];

  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base, endIndex: base + sectionText.length },
      paragraphStyle: { alignment: 'START' },
      fields: 'alignment',
    },
  });

  // Title heading — bold, 16pt.
  requests.push({
    updateTextStyle: {
      range: { startIndex: base + heading.start, endIndex: base + heading.end },
      textStyle: { bold: true, fontSize: { magnitude: 16, unit: 'PT' } },
      fields: 'bold,fontSize',
    },
  });
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: base + heading.start, endIndex: base + heading.end },
      paragraphStyle: { keepWithNext: true },
      fields: 'keepWithNext',
    },
  });

  // Each of the 7 section sub-headers — bold, 12pt.
  for (const sub of subheads) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: base + sub.start, endIndex: base + sub.end },
        textStyle: { bold: true, fontSize: { magnitude: 12, unit: 'PT' } },
        fields: 'bold,fontSize',
      },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: base + sub.start, endIndex: base + sub.end },
        paragraphStyle: { keepWithNext: true, spaceAbove: { magnitude: 10, unit: 'PT' } },
        fields: 'keepWithNext,spaceAbove',
      },
    });
  }

  await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });

  console.log(`[executive] wrote section for ${label} to doc ${docId}`);
  return { docId, start, end, url: `https://docs.google.com/document/d/${docId}/edit` };
}
