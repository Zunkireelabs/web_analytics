import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressReportHtml, planPages } from './progress-pdf.js';
import { deriveBrandTheme } from './brand-theme.js';
import { buildWorkItems, tallyWork } from './work-catalogue.js';

const full = () => {
  const work = buildWorkItems({
    drafts: [{ action_type: 'faq', status: 'implemented' }, { action_type: 'schema', status: 'pr_opened' }],
    openRecs: [{ recommendation_type: 'alt-text' }],
    manual: [{ group: 'Trust', status: 'google', title: 'Clearing out your previous website', did: 'We submitted the removal.', why: 'x', next: 'Google decides.' }],
  });
  return {
    siteName: 'Acme & Sons', dateLabel: 'October 30, 2026', monthLabel: 'October 2026', dataThrough: 'October 27, 2026',
    theme: deriveBrandTheme('#c8a96e'),
    ai: { base: 39, now: 77 }, pages: { base: 19, now: 104 }, google: { impressions: 249, clicks: 7 },
    weekly: [{ label: 'Aug 17', impressions: 14, clicks: 1 }, { label: 'Aug 24', impressions: 16, clicks: 0 }],
    searches: [{ query: 'removals kettering', impressions: 12, page: 8 }],
    previousSite: { pagesInTen: 4, unrelatedSearches: 40, totalSearches: 87 },
    checks: [{ key: 'faq', name: 'Questions and answers', sub: 's', base: 60, now: 88, tag: 'IMPROVED', did: 'We added question-and-answer sections to 1 page.' }],
    work, tally: tallyWork(work),
    listings: [{ name: 'Yell', kind: 'UK business directory', status: 'listed' }],
    nap: { name: 'Acme Ltd', phone: '+44 1', address: '1 High St' },
    headline: { lead: '<b>Your website became much easier for AI tools to read</b>', grew: ' and has grown to 104 pages' },
  };
};

describe('renderProgressReportHtml', () => {
  test('renders every page for a client with full data, with page numbers that match the plan', () => {
    const html = renderProgressReportHtml(full());
    assert.equal((html.match(/<section class="page/g) || []).length, 7);
    const { keys } = planPages(full());
    assert.deepEqual(keys, ['cover', 'glance', 'checks', 'completed', 'progress', 'listings', 'next']);
    assert.match(html, /Monthly<br>Progress/);
    assert.match(html, /249/); assert.match(html, /Google page 8/);
  });

  test('escapes client-supplied text', () => {
    const html = renderProgressReportHtml(full());
    assert.match(html, /Acme &amp; Sons/);
    assert.doesNotMatch(html, /Acme & Sons/);
  });

  test('uses the client\'s own accent colour, and Zunkiree green when none is stored', () => {
    assert.match(renderProgressReportHtml(full()), /--a:#c8a96e/);
    const d = full(); d.theme = deriveBrandTheme(null);
    assert.match(renderProgressReportHtml(d), /--a:#76b900/);
  });

  test('never shows a mockup badge or exact-date chips', () => {
    const html = renderProgressReportHtml(full());
    assert.doesNotMatch(html, /class="badge"/);
    assert.doesNotMatch(html, /class="wd">\s*(SEP|OCT|AUG)/);
  });

  test('says not measured yet instead of inventing numbers, and drops pages with nothing real on them', () => {
    const html = renderProgressReportHtml({
      siteName: 'New Client', dateLabel: 'October 30, 2026', theme: deriveBrandTheme(null),
      ai: null, pages: null, google: null,
    });
    assert.match(html, /NOT MEASURED YET/);
    assert.equal((html.match(/<section class="page/g) || []).length, 4); // cover, glance, completed, next
  });

  test('a clean site never shows the previous-website box', () => {
    const d = full(); d.previousSite = null;
    const html = renderProgressReportHtml(d);
    assert.doesNotMatch(html, /held back: your previous website/);
    assert.doesNotMatch(html, /Your previous website is still being cleared/);
  });

  test('waiting work reads as a next step, not as past tense', () => {
    const html = renderProgressReportHtml(full());
    assert.match(html, /Confirm “Added labels that explain your pages” is live/);
  });
});
