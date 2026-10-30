import { fetchPage } from './fetchPage.js';
import { renderPageDetails } from './renderPage.js';
import { seoChecks, aeoChecks, agenticChecks, geoChecks, optionalRenderChecks } from './checks/index.js';
import { scoreAll } from './scoring.js';

function runChecks(checks, pageData) {
  const results = [];
  for (const check of checks) {
    const result = check(pageData);
    if (Array.isArray(result)) results.push(...result);
    else results.push(result);
  }
  return results;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'you', 'are', 'was',
  'were', 'have', 'has', 'will', 'can', 'not', 'all', 'but', 'about', 'into', 'their',
  'they', 'them', 'than', 'then', 'when', 'what', 'how', 'why', 'who', 'would', 'should',
  'could', 'some', 'here', 'there', 'these', 'that'
]);

function extractKeywordsAndPhrases($, title, description, headingsText) {
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript, svg, iframe, link, meta').remove();
  const bodyText = bodyClone.text().toLowerCase();

  const words = bodyText
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));

  const freq = {};
  words.forEach(w => {
    freq[w] = (freq[w] || 0) + 1;
  });

  const sortedKeywords = Object.keys(freq)
    .map(w => ({
      word: w,
      count: freq[w],
      inTitle: title.toLowerCase().includes(w),
      inDesc: description.toLowerCase().includes(w),
      inHeadings: headingsText.toLowerCase().includes(w)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const plainWords = bodyText
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  const phrases = [];
  for (let i = 0; i < plainWords.length - 1; i++) {
    const w1 = plainWords[i];
    const w2 = plainWords[i+1];
    if (w1.length > 3 && w2.length > 3 && !STOPWORDS.has(w1) && !STOPWORDS.has(w2)) {
      phrases.push(`${w1} ${w2}`);
    }
  }

  const phraseFreq = {};
  phrases.forEach(p => {
    phraseFreq[p] = (phraseFreq[p] || 0) + 1;
  });

  const sortedPhrases = Object.keys(phraseFreq)
    .map(p => ({
      phrase: p,
      count: phraseFreq[p],
      inTitle: title.toLowerCase().includes(p),
      inDesc: description.toLowerCase().includes(p),
      inHeadings: headingsText.toLowerCase().includes(p)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  return {
    keywords: sortedKeywords,
    phrases: sortedPhrases
  };
}

async function runAudit(inputUrl, { renderMode = 'raw', siteCache } = {}) {
  const startedAt = Date.now();
  const pageData = await fetchPage(inputUrl, { siteCache });

  if (renderMode === 'js') {
    pageData.render = await renderPageDetails(pageData.finalUrl);
  }

  const checks = runChecks([...seoChecks, ...aeoChecks, ...agenticChecks, ...geoChecks], pageData);

  if (renderMode === 'js') {
    checks.push(...runChecks(optionalRenderChecks, pageData));
  }

  const overall = scoreAll(checks);

  const $ = pageData.$;
  const titleText = $('title').first().text().trim() || '';
  const descText = $('meta[name="description"]').attr('content') || '';
  const headingsText = $('h1, h2, h3, h4, h5, h6').text();
  const kwAnalysis = extractKeywordsAndPhrases($, titleText, descText, headingsText);

  const pageMetadata = {
    title: titleText || null,
    description: descText || null,
    h1s: $('h1').map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean),
    headings: $('h1, h2, h3, h4, h5, h6').map((i, el) => ({
      tag: el.tagName.toLowerCase(),
      text: $(el).text().replace(/\s+/g, ' ').trim()
    })).get().filter(h => !!h.text),
    canonical: $('link[rel="canonical"]').attr('href') || null,
    og: {
      title: $('meta[property="og:title"]').attr('content') || null,
      description: $('meta[property="og:description"]').attr('content') || null,
      image: $('meta[property="og:image"]').attr('content') || null
    },
    twitter: {
      card: $('meta[name="twitter:card"]').attr('content') || null,
      title: $('meta[name="twitter:title"]').attr('content') || null,
      description: $('meta[name="twitter:description"]').attr('content') || null,
      image: $('meta[name="twitter:image"]').attr('content') || null
    },
    images: $('img').map((i, el) => ({
      src: $(el).attr('src') || '',
      alt: $(el).attr('alt') || ''
    })).get(),
    schemas: $('script[type="application/ld+json"]').map((i, el) => {
      try {
        return JSON.parse($(el).html());
      } catch {
        return null;
      }
    }).get().filter(Boolean),
    keywordConsistency: kwAnalysis,
    screenshotDesktop: (pageData.render && pageData.render.screenshotDesktop) || null,
    screenshotMobile: (pageData.render && pageData.render.screenshotMobile) || null
  };

  return {
    url: pageData.url,
    finalUrl: pageData.finalUrl,
    fetchedAt: new Date().toISOString(),
    overall,
    checks,
    pageMetadata,
    meta: {
      redirectCount: pageData.redirectCount,
      statusCode: pageData.statusCode,
      durationMs: Date.now() - startedAt,
    },
  };
}

export { runAudit };
