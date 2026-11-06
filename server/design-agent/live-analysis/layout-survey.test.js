import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { structuralSignature, clusterPages, surveyLayouts, compactSurvey, jaccard } from './layout-survey.js';

const O = 'https://x.test';
// A page is <main> with a set of section class strings; shared chrome sits outside <main>.
const page = (...sectionClasses) => `<html><header class="hd a b c d e f g"></header><main>${sectionClasses.map((c) => `<section class="${c}"><p class="p1 p2">t</p></section>`).join('')}</main><footer class="ft"></footer></html>`;
const POST = ['post-wrap max-w-3xl mx-auto', 'post-title text-4xl font-bold', 'post-body prose prose-lg', 'author-box flex gap-4', 'related grid grid-cols-3'];
const SERVICE = ['svc-hero bg-navy text-white py-24', 'svc-grid grid grid-cols-2 gap-8', 'svc-cta bg-gold px-8 py-12'];

describe('structuralSignature', () => {
  test('reads classes from <main> only, so shared header/footer chrome does not make pages look alike', () => {
    const sig = structuralSignature(page('only-here'));
    assert.ok(sig.has('only-here'));
    assert.equal(sig.has('hd'), false);
    assert.equal(sig.has('ft'), false);
  });
});

describe('clusterPages', () => {
  const sig = (html) => structuralSignature(html);
  test('pages from one template group together; a redesigned page is its own group', () => {
    const pages = [
      { url: `${O}/blog/a`, classes: sig(page(...POST)) },
      { url: `${O}/blog/b`, classes: sig(page(...POST, 'extra-note')) },
      { url: `${O}/blog/c`, classes: sig(page(...POST)) },
      { url: `${O}/blog/redesigned`, classes: sig(page(...SERVICE)) },
      { url: `${O}/services/x`, classes: sig(page(...SERVICE)) },
    ];
    const groups = clusterPages(pages);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].members.length, 3, 'the three posts');
    const svc = groups.find((g) => g.members.includes(`${O}/services/x`));
    assert.ok(svc.members.includes(`${O}/blog/redesigned`), 'a /blog/ URL that looks like a service page groups by LOOKS, not by URL');
  });

  test('the sample is a central member, not an odd one that slipped in', () => {
    const base = POST.join(' ');
    const mk = (extra) => ({ url: `${O}/p/${extra}`, classes: new Set([...base.split(' '), ...extra.split(' ')]) });
    const groups = clusterPages([mk('z1'), mk('z2'), mk('z3 z4 z5 z6 z7 z8 z9'), mk('z1 z2')], { threshold: 0.4 });
    assert.equal(groups.length, 1);
    assert.notEqual(groups[0].sample, `${O}/p/z3 z4 z5 z6 z7 z8 z9`);
  });

  test('jaccard of identical sets is 1 and of disjoint sets is 0', () => {
    assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
});

describe('surveyLayouts', () => {
  const html = { [`${O}/blog/a`]: page(...POST), [`${O}/blog/b`]: page(...POST), [`${O}/services/x`]: page(...SERVICE), [`${O}/empty`]: '<html><body></body></html>' };
  const fetchHtml = async (u) => { if (u in html) return html[u]; return null; };

  test('fetches every page, groups them, and reports unreachable and unreadable pages instead of hiding them', async () => {
    const survey = await surveyLayouts([...Object.keys(html), `${O}/gone`, `${O}/test/skip-me`, `${O}/blog/a`], { fetchHtml });
    assert.equal(survey.pagesSurveyed, 3);
    assert.equal(survey.groups.length, 2);
    assert.deepEqual(survey.unreachable, [`${O}/gone`]);
    assert.deepEqual(survey.unreadable, [`${O}/empty`]);
  });

  test('compactSurvey keeps paths only and maps every surveyed page to a group', async () => {
    const survey = await surveyLayouts(Object.keys(html), { fetchHtml });
    const c = compactSurvey(survey);
    assert.deepEqual(c.groups.flatMap((g) => g.members).sort(), ['/blog/a', '/blog/b', '/services/x']);
    assert.ok(c.groups.every((g) => g.sample.startsWith('/')));
    assert.equal(compactSurvey({ groups: [] }), null);
  });
});
