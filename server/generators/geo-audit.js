import { getSiteById, getSearchPerformanceRange, getQueriesForPage } from '../store/read.js';
import { analyzePageUrl, checkLlmsReadiness } from '../agents/lib/page-content.js';
import { knownDomain } from '../agents/lib/site-domain.js';
import { scorePageCategories, scoreLlmsReadiness, combineScores, geoSignalsScore } from '../agents/lib/visibility-score.js';
import { priorityByRank, impactFromPriority, makeFinding } from '../agents/lib/findings.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'geo-audit',
  name: 'GEO Audit Generator',
  description: 'Produces a comprehensive GEO audit report for a site — AI visibility score, per-page findings, and prioritized fix list mapped to generators.',
  recommendationTags: ['GEO audit', 'AI visibility', 'structured data', 'llms.txt'],
};

const DEFAULT_WINDOW_DAYS = 90;
const MAX_PAGES = 20;
const LLMS_TXT_KEY_PAGES_LIMIT = 8;

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function scoreLabel(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  if (score >= 20) return 'Poor';
  return 'Critical';
}

function priorityForScore(score) {
  if (score < 30) return 'high';
  if (score < 50) return 'medium';
  return 'low';
}

function buildPageFindings(page, score, priority) {
  const findings = [];
  const cats = score.categories;

  if (cats.schema <= 50) {
    findings.push({
      label: 'Add schema markup (e.g. Article, Product, or Organization as relevant to the page).',
      generatorId: 'schema',
      params: { page: page.page, schemaType: 'Article' },
      effort: 'Low',
    });
  }
  if (cats.structuredContent < 100) {
    findings.push({
      label: 'Fix heading structure: exactly one H1, add H2 subheadings, and add a list or table.',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'qa-subheadings' },
      effort: 'Medium',
    });
  }
  if (cats.faq === 0) {
    findings.push({
      label: 'Add an FAQ section.',
      generatorId: 'faq',
      params: { page: page.page, query: page.topQuery || '', schemaType: 'FAQPage' },
      effort: 'Low',
    });
  }
  if (cats.entities < 70) {
    findings.push({
      label: 'Add entity schema (Organization, Product, Person, or LocalBusiness) to help AI engines identify what/who the page is about.',
      generatorId: 'schema',
      params: { page: page.page, schemaType: 'Organization' },
      effort: 'Low',
    });
  }
  if (cats.citationReadiness < 60) {
    findings.push({
      label: 'Add question-style subheadings (e.g. "What is...", "How does...") for direct-answer extraction.',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'qa-subheadings' },
      effort: 'Medium',
    });
  }

  // GEO signal findings
  if (!page.analysis?.hasAuthorSignal) {
    findings.push({
      label: 'Add author/byline markup (schema author field or visible byline) so AI engines attribute the content.',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'author-byline' },
      effort: 'Low',
    });
  }
  if (!page.analysis?.hasFreshnessSignal) {
    findings.push({
      label: 'Add publish or last-updated date (datePublished/dateModified schema, article meta tag, or visible <time> element).',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'freshness-date' },
      effort: 'Low',
    });
  }
  if (!page.analysis?.hasComparisonContent) {
    findings.push({
      label: 'Add comparison, alternatives, or "best of" content — generative engines disproportionately cite this shape.',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'comparison-content' },
      effort: 'Medium',
    });
  }
  if (!page.analysis?.hasExternalCitations) {
    findings.push({
      label: 'Cite external authoritative sources within the page content — AI assistants favor well-sourced content.',
      generatorId: 'expand-content',
      params: { page: page.page, query: page.topQuery || '', focus: 'external-citations' },
      effort: 'Low',
    });
  }
  if (!page.analysis?.hasReviewSchema) {
    findings.push({
      label: 'Add Review or AggregateRating JSON-LD schema so AI assistants can surface social proof.',
      generatorId: 'schema',
      params: { page: page.page, schemaType: 'Review' },
      effort: 'Low',
    });
  }

  return findings.map((f) =>
    makeFinding({
      id: `geo-audit:${page.page}:${f.label}`,
      evidence: { page: page.page, score: score.overall, impressions: page.impressions },
      whyItMatters: `AI Visibility score ${score.overall}/100 for this page (${page.impressions} impressions).`,
      priority,
      recommendedAction: {
        label: f.label,
        generatorId: f.generatorId,
        params: f.params,
        effort: f.effort,
      },
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: page.impressions },
    })
  );
}

export async function generate({ siteId, params }) {
  const { start, end } = params.start && params.end ? params : defaultRange();
  const site = await getSiteById(siteId);
  const siteName = site?.name || 'This site';
  const domain = knownDomain(site);

  const pagePerfRaw = await getSearchPerformanceRange(siteId, start, end, 'page', MAX_PAGES);
  const pagePerf = pagePerfRaw
    .filter((p) => Number(p.impressions) >= 5)
    .sort((a, b) => Number(b.impressions) - Number(a.impressions))
    .slice(0, MAX_PAGES);

  const urls = pagePerf.map((p) => p.dim_value);

  const fetched = await Promise.all(
    urls.map(async (url) => {
      const result = await analyzePageUrl(url);
      const queries = await getQueriesForPage(siteId, start, end, url, 1);
      const topQuery = queries[0]?.query || '';
      const perf = pagePerf.find((p) => p.dim_value === url);
      return { page: url, result, topQuery, impressions: Number(perf?.impressions || 0) };
    })
  );

  const llmsReadiness = await checkLlmsReadiness(domain);
  const llmsScore = llmsReadiness ? scoreLlmsReadiness(llmsReadiness) : null;

  const pages = fetched.map((f) => {
    if (!f.result.ok) return { page: f.page, score: null, fetchError: f.result.error, impressions: f.impressions };
    const categories = scorePageCategories(f.result.analysis);
    const geoScore = geoSignalsScore(f.result.analysis);
        const scored = llmsScore != null ? combineScores(categories, llmsScore, geoScore) : { overall: null, categories };
    return { page: f.page, score: scored, topQuery: f.topQuery, impressions: f.impressions, fetchError: null };
  });

  const scoredPages = pages.filter((p) => p.score?.overall != null);
  const prioritized = [...scoredPages].sort((a, b) => a.score.overall - b.score.overall || b.impressions - a.impressions);
  const priorities = priorityByRank(prioritized);

  const allFindings = prioritized.flatMap((p, i) => {
    const priority = priorities[i];
    return buildPageFindings(p, p.score, priority);
  });

  const siteScore = scoredPages.length
    ? {
      overall: Math.round(scoredPages.reduce((s, p) => s + p.score.overall, 0) / scoredPages.length),
      categories: ['schema', 'structuredContent', 'faq', 'entities', 'citationReadiness', 'llmsReadiness', 'geoSignals'].reduce((acc, cat) => {
        acc[cat] = Math.round(scoredPages.reduce((s, p) => s + p.score.categories[cat], 0) / scoredPages.length);
        return acc;
      }, {}),
    }
    : null;

  const lines = [];
  lines.push(`# GEO Audit: ${siteName}`);
  lines.push('');
  lines.push(`> Auto-generated by the Action Center GEO Audit generator. Based on GSC data from ${start} to ${end}.`);
  lines.push('');

  if (siteScore) {
    lines.push(`## Overall AI Visibility Score: ${siteScore.overall}/100 (${scoreLabel(siteScore.overall)})`);
    lines.push('');
    lines.push('| Category | Score | Status |');
    lines.push('|---|---|---|');
    for (const [cat, val] of Object.entries(siteScore.categories)) {
      lines.push(`| ${cat} | ${val}/100 | ${scoreLabel(val)} |`);
    }
    lines.push('');
  }

  const llmsTxtSection = llmsReadiness
    ? (llmsReadiness.hasLlmsTxt && llmsReadiness.robotsAllowsAiCrawlers !== false
      ? '✅ llms.txt present and robots.txt allows AI crawlers.'
      : `⚠️ ${!llmsReadiness.hasLlmsTxt ? 'No llms.txt file found.' : 'robots.txt blocks one or more AI crawlers.'}`)
    : '⚠️ Could not check llms.txt / robots.txt readiness.';
  lines.push(`## Crawlability & AI-Crawler Access`);
  lines.push('');
  lines.push(llmsTxtSection);
  lines.push('');

  lines.push('## Top Pages by Urgency (worst AI readiness + highest traffic first)');
  lines.push('');
  lines.push('| # | Page | Score | Impressions | Top Query |');
  lines.push('|---|---|---|---|---|');
  for (let i = 0; i < Math.min(prioritized.length, 10); i++) {
    const p = prioritized[i];
    const priority = priorities[i];
    lines.push(`| ${i + 1} | \`${p.page}\` | ${p.score.overall}/100 (${scoreLabel(p.score.overall)}) | ${p.impressions.toLocaleString()} | ${p.topQuery || '—'} |`);
  }
  lines.push('');

  lines.push('## Recommended Actions');
  lines.push('');
  for (let i = 0; i < Math.min(allFindings.length, 20); i++) {
    const f = allFindings[i];
    const rec = f.recommendedAction;
    lines.push(`${i + 1}. **${rec.label}** — ${f.evidence.page} (priority: ${f.priority}, effort: ${rec.effort})`);
    lines.push(`   - Generator: \`${rec.generatorId}\``);
  }
  lines.push('');

  if (scoredPages.length > 0) {
    const weakest = prioritized[0];
    lines.push('## Summary');
    lines.push('');
    lines.push(`The site's AI visibility score is **${siteScore.overall}/100** (${scoreLabel(siteScore.overall)}). `);
    lines.push(`The weakest category is **${Object.entries(siteScore.categories).sort((a, b) => a[1] - b[1])[0][0]}** (${Object.entries(siteScore.categories).sort((a, b) => a[1] - b[1])[0][1]}/100). `);
    lines.push(`The most urgent page to fix is \`${weakest.page}\` (score: ${weakest.score.overall}/100, ${weakest.impressions.toLocaleString()} impressions). `);
    lines.push(`There are ${allFindings.length} actionable recommendations mapped to generators. `);
    lines.push('');
  }

  const content = lines.join('\n');
  return {
    content,
    summary: `GEO audit for ${siteName} — score ${siteScore?.overall || 'N/A'}/100, ${allFindings.length} findings across ${scoredPages.length} pages`,
  };
}