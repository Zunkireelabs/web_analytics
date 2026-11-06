// The three learning layers, expressed as EVIDENCE for the existing decision engine (agents/lib/decision-engine.js).
//
// decision-engine.js already reasons over a bundle of evidence items ({ source, summary, ref, meta }) gathered by
// agents/lib/decision-evidence.js. Phase 4 does not add a second engine or a second gatherer: it adds three more sources to
// that one, each turning a learning layer into capped, honestly-labelled evidence items:
//
//   project memory      - what is known about THIS project right now (design usable? baseline captured? repo connected?)
//                         with a freshness label, so stale facts read as stale.
//   behaviour learning  - what happened when this project tried each kind of change, with the evidence level, so
//                         "2 attempts" is never worded like "20".
//   industry knowledge  - what other projects in the industry have shown. Only VALIDATED patterns are worded as findings;
//                         starting points and contradicted patterns are labelled as such, so the model cannot mistake
//                         convention for proof. Always "observed association, not proven cause".
//
// Every converter is pure and capped; every loader is best-effort (a failing layer returns [] and never blocks a decision).

import { onUnlessDisabled } from './feature-flags.js';

export const MAX_BEHAVIOUR_ITEMS = 5;
export const MAX_INDUSTRY_ITEMS = 5;

// ── project memory ─────────────────────────────────────────────────────────────────────────────────────────────────

export function projectMemoryToEvidence(memory) {
  if (!memory || !memory.sections) return [];
  const out = [];
  if (memory.growth?.stage) {
    const g = memory.growth;
    const favours = {
      acceleration: 'fixing what blocks search visibility first, then high-impact on-page work, and measuring against the baseline',
      expansion: 'expanding what already shows demand, plus new content opportunities, based on the first 30 days of results',
      optimisation: 'keeping technical health, catching drops and regressions, and continuing what the results support',
    }[g.stage];
    out.push({
      source: 'project-memory',
      summary: `This project is on day ${g.day} of its growth programme: ${g.label}. In this stage the platform favours ${favours}. This is a priority, not a limit: critical issues are addressed at any stage.`,
      ref: `project-memory:${memory.siteId}:growth-stage`,
      meta: { section: 'growth', stage: g.stage, day: g.day },
    });
  }
  const add = (section, summary, meta = {}) => {
    const s = memory.sections[section];
    out.push({
      source: 'project-memory',
      summary: `${summary}${s.provenance?.freshness && s.provenance.freshness !== 'fresh' ? ` (this information is ${s.provenance.freshness})` : ''}`,
      ref: `project-memory:${memory.siteId}:${section}`,
      meta: { section, freshness: s.provenance?.freshness ?? 'unknown', asOf: s.provenance?.asOf ?? null, ...meta },
    });
  };
  for (const section of Object.keys(memory.sections)) {
    const s = memory.sections[section];
    if (s.status === 'empty') {
      out.push({ source: 'project-memory', summary: `Nothing is recorded yet for this project's ${section} (do not assume it).`, ref: `project-memory:${memory.siteId}:${section}`, meta: { section, status: 'empty' } });
      continue;
    }
    if (s.status !== 'ok' || !s.data) continue;
    const d = s.data;
    if (section === 'design') {
      add(section, d.profilePresent
        ? `Design profile is ${d.usable ? 'usable' : 'present but NOT usable, so visible changes are unsafe'}${d.captureGaps?.length ? `; ${d.captureGaps.length} capture gap(s)` : ''}.`
        : 'No design profile is recorded, so visible changes cannot be checked against the site\'s design.', { usable: Boolean(d.usable) });
    } else if (section === 'technical') {
      add(section, `Repository ${d.repoConnected ? 'is connected' : 'is NOT connected, so changes cannot be shipped'}.`, { repoConnected: Boolean(d.repoConnected) });
    } else if (section === 'search') {
      add(section, `Search baseline ${d.baselineCapturedAt ? 'is captured' : 'is not captured yet'}; ${d.competitorDomains?.length ?? 0} competitor(s) tracked.`, { baseline: Boolean(d.baselineCapturedAt) });
    } else if (section === 'history') {
      add(section, `${d.drafts?.total ?? 0} drafts so far, ${d.drafts?.implemented ?? 0} implemented.`, { drafts: d.drafts?.total ?? 0, implemented: d.drafts?.implemented ?? 0 });
    } else if (section === 'business') {
      add(section, `Industry: ${(d.industries || []).join(', ') || 'not recorded'}; ${d.goals?.length ?? 0} active goal(s).`, { goals: d.goals?.length ?? 0 });
    }
  }
  return out;
}

// ── behaviour learning ─────────────────────────────────────────────────────────────────────────────────────────────

export function behaviourToEvidence(behaviour, siteId) {
  if (!behaviour || !Array.isArray(behaviour.generators)) return [];
  // Strongest evidence first: held-for-review, then established, then limited. Insufficient history is one summary line,
  // not one item per generator, so thin data cannot crowd out real data.
  const level = (g) => (['established', 'limited'].includes(g.technicalEvidence) || ['established', 'limited'].includes(g.impactEvidence)
    ? (g.technicalEvidence === 'established' || g.impactEvidence === 'established' ? 1 : 2) : 3);
  const rank = (g) => (g.demoted ? 0 : level(g));
  const real = behaviour.generators.filter((g) => g.technicalEvidence !== 'none');
  const strong = real.filter((g) => g.demoted || g.technicalEvidence !== 'insufficient' || g.impactEvidence !== 'insufficient')
    .sort((a, b) => rank(a) - rank(b)).slice(0, MAX_BEHAVIOUR_ITEMS);
  const out = strong.map((g) => ({
    source: 'behaviour-learning',
    summary: `[evidence: ${g.technicalEvidence} for shipping, ${g.impactEvidence} for impact] ${g.text}`,
    ref: `behaviour:${siteId}:${g.generatorId}`,
    meta: { generatorId: g.generatorId, technicalEvidence: g.technicalEvidence, impactEvidence: g.impactEvidence, demoted: g.demoted, counts: g.counts },
  }));
  const thin = real.length - strong.length;
  if (thin > 0) out.push({ source: 'behaviour-learning', summary: `${thin} other kind(s) of change have too little history on this project to judge. Nothing is assumed about them.`, ref: `behaviour:${siteId}:insufficient`, meta: { insufficient: thin } });
  return out;
}

// ── industry knowledge ─────────────────────────────────────────────────────────────────────────────────────────────

export function industryToEvidence(intel, siteId) {
  if (!intel || !intel.classified) return [];
  const mk = (i, prefix) => ({
    source: 'industry-intelligence',
    summary: `${prefix} ${i.claim}`,
    ref: `industry:${i.industry}:${i.subIndustry || '-'}:${i.kind}:${i.subject}`,
    meta: { status: i.status, label: i.label, confidence: i.confidence, evidence: i.evidence, kind: i.kind, subject: i.subject },
  });
  const learned = (list) => list.filter((i) => i.kind === 'generator-outcome');
  const out = [
    ...learned(intel.validated).slice(0, MAX_INDUSTRY_ITEMS).map((i) => mk(i, '[industry, validated across projects]')),
    ...learned(intel.contradicted).slice(0, 2).map((i) => mk(i, '[industry, projects DISAGREE - do not rely on this]')),
  ];
  // Starting points are guidance only; included so the engine can see what is conventional, but never worded as proof.
  const room = Math.max(0, MAX_INDUSTRY_ITEMS - out.length);
  out.push(...intel.startingPoints.slice(0, Math.min(room, 2)).map((i) => mk(i, '[industry starting point, NOT confirmed by results]')));
  return out;
}

// ── loaders (best-effort) ──────────────────────────────────────────────────────────────────────────────────────────

export async function loadProjectMemoryEvidence(siteId, deps = {}) {
  const get = deps.getProjectMemory || (await import('./project-memory.js')).getProjectMemory;
  return projectMemoryToEvidence(await get(siteId));
}
export async function loadBehaviourEvidence(siteId, deps = {}) {
  const get = deps.getBehaviourLearning || (await import('./behaviour-learning.js')).getBehaviourLearning;
  return behaviourToEvidence(await get(siteId), siteId);
}
export async function loadIndustryEvidence(siteId, deps = {}) {
  const get = deps.getIndustryIntelligence || (await import('./industry-intelligence.js')).getIndustryIntelligence;
  return industryToEvidence(await get(siteId), siteId);
}

// Whether learning evidence is added to decisions. ON unless explicitly disabled. The decision engine itself still has its own
// per-project switch and budget, so this only matters where the engine runs.
export const learningEvidenceEnabled = (env = process.env) => onUnlessDisabled(env.LEARNING_EVIDENCE_IN_DECISIONS);
