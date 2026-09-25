import { getSiteById } from '../store/read.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { listPageInventory } from '../store/page-inventory.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';

// Comparison-page opportunities (Product Growth spec §3) — the surface AI
// assistants cite most when someone asks "X vs Y" or "alternatives to X".
// Reads competitor-intelligence's own already-identified REAL competitors
// (never invents a competitor name itself) and checks whether this site
// already has a page comparing itself to each one. Routes a genuine gap to
// the existing blog-outline generator (same reuse pattern keyword-
// narrative.js already uses for its own content gaps) — no new generator or
// content-generation pipeline needed.
export const meta = {
  id: 'comparison-opportunity',
  name: 'Comparison Opportunity Agent',
  description: 'Finds real tracked competitors this site has no "vs" comparison page for.',
  category: 'content',
  version: 1,
};

function brandToken(domain) {
  return (domain || '').replace(/^www\./, '').split('.')[0].toLowerCase();
}

export async function run({ siteId }) {
  const [site, [competitorRun], pages] = await Promise.all([
    getSiteById(siteId),
    getLatestAgentRuns(siteId, ['competitor-intelligence']),
    listPageInventory(siteId, { limit: 500 }),
  ]);

  const competitors = competitorRun?.facts?.competitorsIdentified || [];
  if (!competitors.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No real tracked competitors yet — run competitor-intelligence first.',
      generatedAt: new Date().toISOString(),
    };
  }

  const pagePaths = pages.map((p) => p.page.toLowerCase());
  const gaps = competitors.filter((domain) => {
    const brand = brandToken(domain);
    if (!brand) return false;
    return !pagePaths.some((p) => p.includes(brand) && (p.includes('vs') || p.includes('compar') || p.includes('alternative')));
  });

  const priorities = priorityByRank(gaps);
  const findings = gaps.map((domain, i) => {
    const brand = brandToken(domain);
    const siteName = site?.name || 'this site';
    return makeFinding({
      id: `comparison-opportunity:${domain}`,
      evidence: { competitorDomain: domain, checkedPages: pagePaths.length },
      whyItMatters: `${domain} is a real tracked competitor (see competitor-intelligence) with no comparison page on this site — a common query/AI-citation surface this site currently can't win.`,
      priority: priorities[i],
      recommendedAction: {
        label: `Cover: ${siteName} vs ${brand}`,
        generatorId: 'blog-outline',
        params: {
          topic: `${siteName} vs ${brand}`,
          context: `Real tracked competitor (competitor-intelligence, domain: ${domain}) with no comparison page on this site yet. Write an honest, evidence-grounded comparison — never fabricate a competitor claim or pricing detail that isn't independently verifiable.`,
        },
        effort: effortForGenerator('blog-outline'),
      },
      expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'estimate' },
    });
  });

  if (!findings.length) {
    return {
      meta, status: 'ok',
      facts: { competitors, checkedPages: pagePaths.length, findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const facts = { competitors, checkedPages: pagePaths.length, findings };
  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}
