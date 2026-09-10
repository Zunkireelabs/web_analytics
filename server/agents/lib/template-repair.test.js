import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { repairSiteTemplates } from './template-repair.js';

// The gap this closes was costing site 1 real shippable work. Three of its
// four component templates held genuine repo-derived markup and were blocked
// solely for want of a verification stamp — every class they claimed was
// present in the live shipped CSS. The repair is a page fetch, not a
// container job.

const FAQ_ROW = '<div class="py-5"><span class="text-lg">{{QUESTION}}</span><p class="pt-4">{{ANSWER}}</p></div>';
const FAQ_WRAPPER = '<section class="py-12"><div class="divide-y divide-gray-200">{{ROWS}}</div></section>';

// Real Tailwind output shape: the check looks for `.class` followed by a
// character that only appears in a genuine selector.
const LIVE_CSS = [
  '.py-5{padding:1.25rem 0}', '.text-lg{font-size:1.125rem}', '.pt-4{padding-top:1rem}',
  '.py-12{padding:3rem 0}', '.divide-y>:not([hidden]){border-top-width:1px}', '.divide-gray-200{border-color:#e5e7eb}',
].join('\n');

// Body actually contains real examples of every shape this test file
// verifies (FAQ/QA's shared accordion shape, plus internalLinks' distinct
// `<ul>` shape) — structural verification checks this too now, not just
// class-existence (see design-drift.js's checkTemplateStructuralMatch).
const INTERNAL_LINKS_WRAPPER = '<section class="py-12"><ul class="space-y-3">{{ROWS}}</ul></section>';
const INTERNAL_LINKS_ROW = '<li><a href="{{URL}}" class="text-lg">{{ANCHOR_TEXT}}</a></li>';
const PAGE_HTML = '<html><head><link rel="stylesheet" href="/assets/main.css"></head><body>'
  + FAQ_WRAPPER.replace('{{ROWS}}', FAQ_ROW.replace('{{QUESTION}}', 'Q?').replace('{{ANSWER}}', 'A.'))
  + INTERNAL_LINKS_WRAPPER.replace('{{ROWS}}', INTERNAL_LINKS_ROW.replace('{{URL}}', '/page').replace('{{ANCHOR_TEXT}}', 'Page'))
  + '</body></html>';

let saved;
let audited;
let logged;

function siteWith(templates, overrides = {}) {
  return {
    id: 1, name: 'Zunkiree Labs', website_domain: 'zunkireelabs.com',
    url_file_map: { siteRoot: { componentTemplates: templates } },
    ...overrides,
  };
}

function deps(site, { css = LIVE_CSS, html = PAGE_HTML } = {}) {
  return {
    loadSite: async () => site,
    saveConfig: async (cfg) => { saved = cfg; },
    recordAudit: async (req, ev) => { audited = ev; },
    fetchPage: async () => html,
    fetchStylesheet: async () => css,
    log: { log: (m) => logged.push(m), warn: (m) => logged.push(m) },
  };
}

beforeEach(() => { saved = null; audited = null; logged = []; });

describe('repairSiteTemplates — verifying what is merely unstamped', () => {
  test('stamps an unstamped template whose classes are all live', async () => {
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } });

    const counts = await repairSiteTemplates(1, deps(site));

    assert.equal(counts.verified, 1);
    assert.equal(counts.stale, 0);
    const stamped = saved.urlFileMap.siteRoot.componentTemplates.faq;
    assert.equal(stamped.verifiedBy, 'freshness-check',
      'the stamp must record HOW it was verified, not just that it was');
    assert.ok(stamped.verifiedAt);
    assert.match(stamped.verifiedRef, /zunkireelabs\.com/, 'the evidence is the page it was checked against');
    assert.equal(stamped.wrapper, FAQ_WRAPPER, 'markup must be preserved exactly — this is a stamp, not a rewrite');
    assert.equal(stamped.row, FAQ_ROW);
  });

  test('does NOT stamp a template claiming a class the live site no longer ships', async () => {
    // The real staleness case, and the reason this cannot just stamp
    // everything: a template referencing a purged utility renders unstyled.
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } });
    const cssWithoutDivide = LIVE_CSS.split('\n').filter((l) => !l.startsWith('.divide-y')).join('\n');

    const counts = await repairSiteTemplates(1, deps(site, { css: cssWithoutDivide }));

    assert.equal(counts.verified, 0);
    assert.equal(counts.stale, 1);
    assert.equal(saved, null, 'nothing may be persisted when the evidence says the template is stale');
    assert.ok(logged.some((m) => /divide-y/.test(m)), 'the missing class belongs in the log, not just a boolean');
  });

  test('an unreachable site stamps nothing and is not treated as staleness', async () => {
    // "We could not check" is not "it is bad". Treating a network blip as
    // evidence would queue an expensive re-derivation over nothing.
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } });

    const counts = await repairSiteTemplates(1, { ...deps(site), fetchPage: async () => null });

    assert.equal(counts.verified, 0);
    assert.equal(counts.stale, 0, 'unreachable must never be counted as stale');
    assert.equal(counts.unreachable, 1);
    assert.equal(saved, null);
  });

  test('leaves an already-verified template completely alone', async () => {
    const site = siteWith({
      expandContent: {
        wrapper: '<section class="py-12">{{ROWS}}</section>',
        row: '<div class="py-5"><h3>{{HEADING}}</h3><p>{{BODY}}</p></div>',
        verifiedAt: '2026-08-13T06:14:04.118Z', verifiedBy: 'freshness-check', verifiedRef: 'https://zunkireelabs.com',
      },
    });
    let fetched = false;

    const counts = await repairSiteTemplates(1, {
      ...deps(site), fetchPage: async () => { fetched = true; return PAGE_HTML; },
    });

    assert.equal(counts.skipped, 1);
    assert.equal(counts.verified, 0);
    assert.equal(fetched, false, 'a verified template must cost nothing — that is what the stamp is for');
    assert.equal(saved, null);
  });

  test('writes every repaired key in ONE save, not one per key', async () => {
    // Five racing read-modify-writes against the same JSONB column would lose
    // all but the last.
    const site = siteWith({
      faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW },
      qaContent: { wrapper: FAQ_WRAPPER, row: FAQ_ROW },
      internalLinks: {
        wrapper: '<section class="py-12"><ul class="space-y-3">{{ROWS}}</ul></section>',
        row: '<li><a href="{{URL}}" class="text-lg">{{ANCHOR_TEXT}}</a></li>',
      },
    });
    let saves = 0;

    const counts = await repairSiteTemplates(1, {
      ...deps(site, { css: `${LIVE_CSS}\n.space-y-3>:not([hidden]){margin-top:.75rem}` }),
      saveConfig: async (cfg) => { saves++; saved = cfg; },
    });

    assert.equal(counts.verified, 3, 'this is site 1\'s actual situation: faq, qaContent and internalLinks');
    assert.equal(saves, 1);
    const written = saved.urlFileMap.siteRoot.componentTemplates;
    assert.deepEqual(Object.keys(written).sort(), ['faq', 'internalLinks', 'qaContent']);
    for (const k of Object.keys(written)) assert.equal(written[k].verifiedBy, 'freshness-check');
  });

  test('fetches the page once no matter how many templates are checked', async () => {
    const site = siteWith({
      faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW },
      qaContent: { wrapper: FAQ_WRAPPER, row: FAQ_ROW },
    });
    let pageFetches = 0;

    await repairSiteTemplates(1, {
      ...deps(site),
      fetchPage: async () => { pageFetches++; return PAGE_HTML; },
    });

    assert.equal(pageFetches, 1, 'every component template on a site links the same CSS bundle');
  });

  test('is idempotent — a second run finds nothing left to do', async () => {
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } });

    const first = await repairSiteTemplates(1, deps(site));
    assert.equal(first.verified, 1);

    // Feed the stamped output back in, exactly as the next run would read it.
    const after = siteWith(saved.urlFileMap.siteRoot.componentTemplates);
    saved = null;
    const second = await repairSiteTemplates(1, deps(after));

    assert.equal(second.verified, 0);
    assert.equal(second.skipped, 1);
    assert.equal(saved, null, 'a no-op run must not write');
  });

  test('a site with no live URL is a no-op, not a crash', async () => {
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } }, { website_domain: null, gsc_property: null });
    const counts = await repairSiteTemplates(1, deps(site));
    assert.equal(counts.reason, 'no-live-url');
    assert.equal(saved, null);
  });

  test('records an audit event naming what was verified', async () => {
    const site = siteWith({ faq: { wrapper: FAQ_WRAPPER, row: FAQ_ROW } });
    await repairSiteTemplates(1, deps(site));
    assert.equal(audited.action, 'tenant.component_templates_freshness_verified');
    assert.equal(audited.metadata.verified, 1);
    assert.equal(audited.tenantSiteId, 1);
  });
});
