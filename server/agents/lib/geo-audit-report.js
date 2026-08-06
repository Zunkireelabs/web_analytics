// Pure assembly of a GEO audit report from already-fetched data — no DB or
// network imports, so it's directly testable without DATABASE_URL. The
// generator (server/generators/geo-audit.js) does the fetching and hands
// the results here; this module never touches getSiteById/analyzePageUrl/
// the database. Same split as agents/lib/page-content.js's analyzePage
// (pure) vs analyzePageUrl (fetch wrapper).
import { scorePageCategories, scoreLlmsReadiness, combineScores, geoSignalsScore } from './visibility-score.js';
import { priorityByRank, impactFromPriority, makeFinding } from './findings.js';

const MAX_TOP_PAGES_IN_TABLE = 10;
const MAX_RECOMMENDED_ACTIONS = 20;

function scoreLabel(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  if (score >= 20) return 'Poor';
  return 'Critical';
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
      label: 'Add question-style headings (e.g. "What is...?", "How does...?") with grounded answers — improves featured-snippet and AI-citation eligibility.',
      generatorId: 'qa-content',
      params: { page: page.page, query: page.topQuery || '' },
      effort: 'Low',
    });
  }

  // GEO signal findings — gated on the page's real analysis, not the score
  // category (a page can be schema/structured-content-clean yet still miss
  // an individual GEO signal like a byline or freshness date).
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

// fetched: [{ page, result: { ok, analysis, error }, topQuery, impressions }]
// llmsReadiness: { hasLlmsTxt, hasRobotsTxt, robotsAllowsAiCrawlers } | null
export function buildGeoAuditReport({ siteName, start, end, fetched, llmsReadiness }) {
  const llmsScore = llmsReadiness ? scoreLlmsReadiness(llmsReadiness) : null;

  const pages = fetched.map((f) => {
    if (!f.result.ok) return { page: f.page, score: null, fetchError: f.result.error, impressions: f.impressions };
    const categories = scorePageCategories(f.result.analysis);
    const geoScore = geoSignalsScore(f.result.analysis);
    const scored = llmsScore != null ? combineScores(categories, llmsScore, geoScore) : { overall: null, categories };
    return { page: f.page, score: scored, topQuery: f.topQuery, impressions: f.impressions, fetchError: null, analysis: f.result.analysis };
  });

  const scoredPages = pages.filter((p) => p.score?.overall != null);
  const prioritized = [...scoredPages].sort((a, b) => a.score.overall - b.score.overall || b.impressions - a.impressions);
  const priorities = priorityByRank(prioritized);

  const allFindings = prioritized.flatMap((p, i) => buildPageFindings(p, p.score, priorities[i]));

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
  for (let i = 0; i < Math.min(prioritized.length, MAX_TOP_PAGES_IN_TABLE); i++) {
    const p = prioritized[i];
    lines.push(`| ${i + 1} | \`${p.page}\` | ${p.score.overall}/100 (${scoreLabel(p.score.overall)}) | ${p.impressions.toLocaleString()} | ${p.topQuery || '—'} |`);
  }
  lines.push('');

  lines.push('## Recommended Actions');
  lines.push('');
  for (let i = 0; i < Math.min(allFindings.length, MAX_RECOMMENDED_ACTIONS); i++) {
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

  const report = lines.join('\n');
  return {
    content: {
      report,
      score: siteScore,
      pagesAnalyzed: scoredPages.length,
      start,
      end,
      findings: allFindings,
    },
    summary: `GEO audit for ${siteName} — score ${siteScore?.overall || 'N/A'}/100, ${allFindings.length} findings across ${scoredPages.length} pages`,
  };
}
