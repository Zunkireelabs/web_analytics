import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_STATUSES, foldText, topicTokens, topicKey, detectLanguage, detectMarkets, languageNameToCode,
  pageSignals, pageIntent, scoreCandidate, decideCoverage, staleYearSignal, buildTokenWeights, HOMEPAGE_STRENGTH_CAP,
} from './keyword-coverage.js';

const SITE = 'https://example.com';
const page = (path, extra = {}) => ({ url: `${SITE}${path}`, ...extra });
const decide = (gap, candidates, gapSignals = {}) => decideCoverage({
  gap, candidates, gapSignals: { lang: 'en', markets: [], ...gapSignals }, now: new Date('2026-10-02'),
});

describe('Unicode-aware normalization', () => {
  test('keeps German, Dutch and Devanagari words that [^a-z0-9] used to erase', () => {
    assert.deepEqual(topicTokens('KI-Entwicklung für Unternehmen').sort(), ['entwicklung', 'ki']);
    assert.ok(topicTokens('काठमाडौं मा एआई कम्पनी').length > 0);
    assert.ok(topicTokens('Webentwicklung').length === 1);
  });
  test('sharp s and ss fold together (German vs Swiss spelling)', () => {
    assert.equal(foldText('Maßgeschneiderte'), foldText('Massgeschneiderte'));
    assert.equal(topicKey('Straße'), topicKey('Strasse'));
  });
  test('geo modifiers, generic result words and years are not topic words', () => {
    assert.deepEqual(topicTokens('best web development company in Switzerland 2026'), ['web', 'development']);
  });
  test('topicKey is order- and year-insensitive', () => {
    assert.equal(topicKey('SaaS trends 2024'), topicKey('2027 trends SaaS'));
  });
});

describe('language, market and intent signals', () => {
  test('detects German, Dutch and English from marker words', () => {
    assert.equal(detectLanguage('Webentwicklung Unternehmen Schweiz').lang, 'de');
    assert.equal(detectLanguage('datatechniek oplossingen voor bedrijven').lang, 'nl');
    assert.equal(detectLanguage('web development services').lang, 'en');
    assert.equal(detectLanguage('काठमाडौं').lang, 'ne');
  });
  test('says "unknown" instead of guessing', () => {
    assert.equal(detectLanguage('zunkiree').lang, 'unknown');
  });
  test('maps model language names to codes', () => {
    assert.equal(languageNameToCode('German'), 'de');
    assert.equal(languageNameToCode('unknown'), 'unknown');
  });
  test('detects markets from geo modifiers', () => {
    assert.deepEqual(detectMarkets('webentwicklung schweiz'), ['CH']);
    assert.deepEqual(detectMarkets('ai development kathmandu'), ['NP']);
  });
  test('locale prefixes give language and market; un-prefixed pages are the site default', () => {
    assert.deepEqual([pageSignals(`${SITE}/de-ch/blog/x/`).lang, pageSignals(`${SITE}/de-ch/blog/x/`).markets], ['de', ['CH']]);
    assert.equal(pageSignals(`${SITE}/nl/blog/x/`).lang, 'nl');
    assert.equal(pageSignals(`${SITE}/blog/x/`).lang, 'en');
  });
  test('an un-prefixed page whose text is clearly German is German', () => {
    const s = pageSignals(`${SITE}/blog/ki`, { text: 'Die Zukunft der künstlichen Intelligenz und der Entwicklung für Unternehmen ist nicht einfach' });
    assert.equal(s.lang, 'de');
  });
  test('page intent comes from the URL section', () => {
    assert.equal(pageIntent(`${SITE}/services/web-development/`), 'commercial');
    assert.equal(pageIntent(`${SITE}/de/blog/x/`), 'informational');
    assert.equal(pageIntent(`${SITE}/about/`), 'unknown');
  });
});

describe('decideCoverage — same topic is not the same SEO target', () => {
  test('1. exact keyword already built into a page → duplicate', () => {
    const r = decide({ topic: 'web development', search_intent: 'commercial' }, [page('/services/web-development/')]);
    assert.equal(r.status, 'duplicate');
  });

  test('2. same topic, same intent, same market → covered', () => {
    const r = decide({ topic: 'ai development for startups', search_intent: 'commercial' },
      [page('/services/ai-development/', { queries: [{ query: 'ai development for small startups', impressions: 90 }] })]);
    assert.equal(r.status, 'covered');
  });

  test('3. same topic, different country → market_gap (a global page does not cover a named market)', () => {
    const r = decide({ topic: 'web development company switzerland', search_intent: 'commercial' },
      [page('/services/web-development/')], { markets: ['CH'] });
    assert.equal(r.status, 'market_gap');
  });

  test('4. same topic, different language → language_gap, using the English reading of the keyword', () => {
    const r = decide({ topic: 'Webentwicklung Schweiz', search_intent: 'commercial' },
      [page('/services/web-development/')], { lang: 'de', markets: ['CH'], englishTopic: 'web development switzerland' });
    assert.equal(r.status, 'language_gap');
  });

  test('5. same topic, different intent → intent_gap', () => {
    const r = decide({ topic: 'what is web development', search_intent: 'informational' }, [page('/services/web-development/')]);
    assert.equal(r.status, 'intent_gap');
  });

  test('6. generic service page vs location-specific keyword is NOT suppressed', () => {
    const r = decide({ topic: 'ai development kathmandu', search_intent: 'commercial' }, [page('/services/ai-development/')], { markets: ['NP'] });
    assert.notEqual(r.status, 'duplicate');
    assert.notEqual(r.status, 'covered');
    assert.equal(r.status, 'market_gap');
  });

  test('6b. a page that actually serves the market does cover it', () => {
    const r = decide({ topic: 'ai development kathmandu', search_intent: 'commercial' }, [page('/locations/kathmandu/ai-development/')], { markets: ['NP'] });
    assert.ok(['covered', 'duplicate'].includes(r.status), r.status);
  });

  test('7. informational article vs commercial service keyword is NOT suppressed', () => {
    const r = decide({ topic: 'custom software development', search_intent: 'commercial' }, [page('/blog/custom-software-development/')]);
    assert.equal(r.status, 'intent_gap');
  });

  test('8. different wording, same target: a page already ranking for the keyword is covered', () => {
    const r = decide({ topic: 'cost of building an app', search_intent: 'informational' },
      [page('/blog/app-pricing-guide/', { queries: [{ query: 'cost of building an app', impressions: 60, position: 9 }] })]);
    assert.equal(r.status, 'covered');
    assert.equal(r.evidence.matchedOn, 'ranking-query');
  });

  test('9. weak similarity stays an opportunity', () => {
    const none = decide({ topic: 'ai customer support chatbot' }, [page('/services/web-development/')]);
    assert.equal(none.status, 'opportunity');
    const weak = decide({ topic: 'ai customer support chatbot' }, [page('/services/ai-development/')]);
    assert.equal(weak.status, 'opportunity'); // 1 of 4 topic words
  });

  test('9b. moderate overlap is ambiguous, not silently covered or dropped', () => {
    const r = decide({ topic: 'ai customer support chatbot' }, [page('/services/ai-customer-experience/')]);
    assert.equal(r.status, 'uncertain'); // 2 of 4 topic words
    assert.equal(r.needsLLM, true);
  });

  test('10. insufficient evidence → uncertain, never silently dropped', () => {
    assert.equal(decide({ topic: 'best companies' }, [page('/services/web-development/')]).status, 'uncertain');
    const partial = decide({ topic: 'ai development security audit' }, [page('/services/ai-development/')]);
    assert.equal(partial.status, 'uncertain');
    assert.equal(partial.needsLLM, true);
  });

  test('every verdict is one of the declared statuses', () => {
    const r = decide({ topic: 'web development' }, [page('/services/web-development/')]);
    assert.ok(COVERAGE_STATUSES.includes(r.status));
  });

  test('no candidates → opportunity', () => {
    assert.equal(decide({ topic: 'quantum chatbot' }, []).status, 'opportunity');
  });
});

describe('15. dated content', () => {
  test('an older-year page is flagged for REFRESH, with a reason that forbids a year swap', () => {
    const s = staleYearSignal(`${SITE}/blog/saas-trends-for-2024/`, 'saas trends 2027', new Date('2027-01-05'));
    assert.equal(s.stale, true);
    assert.match(s.reason, /do not just change the year/i);
  });
  test('a current-year page is not stale', () => {
    assert.equal(staleYearSignal(`${SITE}/blog/top-ai-companies-nepal-2026/`, 'top ai companies nepal', new Date('2026-10-02')).stale, false);
  });
  test('year differences do not make a topic look new', () => {
    const r = decide({ topic: 'saas trends 2027', search_intent: 'informational' }, [page('/blog/saas-trends-for-2024/')]);
    assert.ok(['duplicate', 'covered'].includes(r.status), r.status);
    assert.equal(r.evidence.needsRefresh, true);
  });
});

describe('scoring', () => {
  test('a ranking query counts for more than nothing, and exact slug is exact', () => {
    const exact = scoreCandidate(topicTokens('web development'), page('/services/web-development/'));
    assert.equal(exact.exact, true);
    const ranking = scoreCandidate(topicTokens('web development'), page('/x/', { queries: [{ query: 'web development' }] }));
    assert.equal(ranking.exact, false);
    assert.equal(ranking.strength, 1);
  });
});

describe('evidence quality', () => {
  const manyPages = Array.from({ length: 20 }, (_, i) => `${SITE}/blog/ai-topic-${i}/`);

  test('words on a large share of the site (ai on an AI company) weigh less', () => {
    const w = buildTokenWeights(manyPages);
    assert.ok(w.get('ai') < 1);
    assert.equal(w.get('topic') < 1, true);
  });

  test('one shared common word no longer makes a page look like a match', () => {
    const weights = buildTokenWeights(manyPages);
    const r = decideCoverage({
      gap: { topic: 'ai oplossingen voor onderwijs' }, gapSignals: { lang: 'nl', markets: [] },
      candidates: [page('/blog/ai-topic-3/')], tokenWeights: weights, now: new Date('2026-10-02'),
    });
    assert.equal(r.status, 'opportunity');
  });

  test('a page that barely ranks (far down, near-zero impressions) is not coverage', () => {
    const r = decide({ topic: 'mobile app development kathmandu' }, [page('/blog/x/', { queries: [{ query: 'mobile app development kathmandu', impressions: 1, position: 70 }] })]);
    assert.equal(r.status, 'opportunity');
  });

  test('a real ranking is coverage', () => {
    const r = decide({ topic: 'mobile app development' }, [page('/blog/x/', { queries: [{ query: 'mobile app development', impressions: 40, position: 12 }] })]);
    assert.equal(r.status, 'covered');
  });

  test('the homepage ranking for a specific keyword is capped into judgment, never accepted outright', () => {
    const s = scoreCandidate(topicTokens('mobile app development'), { url: `${SITE}/`, queries: [{ query: 'mobile app development', impressions: 90, position: 8 }] });
    assert.equal(s.strength, HOMEPAGE_STRENGTH_CAP);
    const r = decide({ topic: 'mobile app development' }, [{ url: `${SITE}/`, queries: [{ query: 'mobile app development', impressions: 90, position: 8 }] }]);
    assert.equal(r.status, 'uncertain');
    assert.equal(r.needsLLM, true);
  });
});
