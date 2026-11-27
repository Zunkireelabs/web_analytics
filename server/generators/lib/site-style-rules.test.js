import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStyleRules, applyToText, normalizeContent, styleViolations, styleRulesPrompt, loadSiteStyleRules, clearSiteStyleRulesCache } from './site-style-rules.js';

const ADMIZZ = `## Language and style (American English, site-wide)
- American spelling in all visible text: counseling/counselor, program.
- "Nepali" (not "Nepalese") in visible text. Slugs and URLs never change.
- Dates are month-first: November 30, 2026.
- Title under about 60 characters, description under about 160.`;

test('parses the rules a client writes', () => {
  const r = parseStyleRules(ADMIZZ);
  assert.equal(r.american, true);
  assert.deepEqual(r.swaps, [['Nepalese', 'Nepali']]);
  assert.equal(r.monthFirst, true);
  assert.equal(r.titleMax, 65);
});
test('a rules file that asks for nothing we can enforce gives null', () => {
  assert.equal(parseStyleRules('Be nice to readers.'), null);
  assert.equal(parseStyleRules(''), null);
});
test('rewrites visible words but never URLs, slugs or official names', () => {
  const r = parseStyleRules(ADMIZZ);
  assert.equal(applyToText('Our counselling programme for Nepalese students', r), 'Our counseling program for Nepali students');
  assert.equal(applyToText('See [guide](https://x.com/for-nepalese-students) and /for-nepalese-students', r), 'See [guide](https://x.com/for-nepalese-students) and /for-nepalese-students');
  assert.equal(applyToText('Confirmation of Enrolment', r), 'Confirmation of Enrolment');
  assert.equal(applyToText('Starts 1 July and ends 30 June.', r), 'Starts July 1 and ends June 30.');
  assert.equal(applyToText('Recognised, ORGANISED', r), 'Recognized, ORGANIZED');
});
test('normalizeContent leaves slugs, urls and the topic alone and shortens a long title at a word', () => {
  const r = parseStyleRules(ADMIZZ);
  const c = normalizeContent({ title: 'Germany and the UK-EU Youth Mobility Deal: What Nepalese Students Should Know', topic: 'enrolment', sections: [{ heading: 'Programme', body: 'organised' }], categories: [{ slug: 'for-nepalese-students', title: 'Nepalese' }], sources: [{ url: 'https://a.b/nepalese', label: 'Programme page' }] }, r);
  assert.ok(c.title.length <= 65, c.title);
  assert.equal(c.topic, 'enrolment');
  assert.equal(c.sections[0].heading, 'Program');
  assert.equal(c.sections[0].body, 'organized');
  assert.equal(c.categories[0].slug, 'for-nepalese-students');
  assert.equal(c.sources[0].url, 'https://a.b/nepalese');
  assert.equal(c.sources[0].label, 'Program page');
});
test('no rules means no change at all', () => {
  const c = { title: 'A programme', sections: [{ body: 'Nepalese' }] };
  assert.equal(normalizeContent(c, null), c);
  assert.deepEqual(styleViolations(c, null), []);
});
test('violations clear once normalized', () => {
  const r = parseStyleRules(ADMIZZ);
  const bad = { title: 'Counselling', sections: [{ body: '1 July' }] };
  assert.ok(styleViolations(bad, r).length > 0);
  assert.deepEqual(styleViolations(normalizeContent(bad, r), r), []);
});
test('prompt names the rules; empty without them', () => {
  assert.match(styleRulesPrompt(parseStyleRules(ADMIZZ)), /American English.*"Nepali", never "Nepalese".*month-first/s);
  assert.equal(styleRulesPrompt(null), '');
});
test('loads from the repo, caches per site, and a failed read gives null', async () => {
  clearSiteStyleRulesCache();
  let calls = 0;
  const ok = async () => { calls += 1; return { content: ADMIZZ }; };
  const a = await loadSiteStyleRules({ id: 1, repo_default_branch: 'main' }, { fetchFile: ok });
  await loadSiteStyleRules({ id: 1 }, { fetchFile: ok });
  assert.equal(a.american, true); assert.equal(calls, 1);
  const none = await loadSiteStyleRules({ id: 2 }, { fetchFile: async () => null });
  assert.equal(none, null);
  const boom = await loadSiteStyleRules({ id: 3 }, { fetchFile: async () => { throw new Error('x'); } });
  assert.equal(boom, null);
  // one client's rules never reach another
  assert.equal((await loadSiteStyleRules({ id: 2 }, { fetchFile: ok })), null);
});

test('a failed read is never cached, and the ship step can ask for it to throw instead of meaning "no rules"', async () => {
  clearSiteStyleRulesCache();
  let n = 0;
  const flaky = async () => { n += 1; if (n === 1) throw new Error('GitHub 502'); return { content: ADMIZZ }; };
  assert.equal(await loadSiteStyleRules({ id: 11 }, { fetchFile: flaky }), null, 'best effort for a draft: no rules this time');
  assert.equal((await loadSiteStyleRules({ id: 11 }, { fetchFile: flaky })).american, true, 'the failure was not remembered');
  clearSiteStyleRulesCache();
  await assert.rejects(loadSiteStyleRules({ id: 12 }, { fetchFile: async () => { throw new Error('GitHub 502'); }, strict: true }), /502/);
  assert.equal(await loadSiteStyleRules({ id: 13 }, { fetchFile: async () => null, strict: true }), null, 'a site with no rules file simply has none');
});
