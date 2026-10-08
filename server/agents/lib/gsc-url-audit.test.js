import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrlKey, hostOf, classifyHost, isTombstoned, classifyProbe,
  hasNoindexSignal, isHandledByOffsiteRedirect, groupByHost,
  buildDeadOwnUrlsFinding, buildUnexpectedHostsFinding,
} from './gsc-url-audit.js';

// The real situation this agent was written for: one domain-level property
// covering a marketing site plus a CMS, a CRM and an unrelated client project
// that all happen to live on subdomains of the same root domain.
const SITE = {
  ownDomains: ['zunkireelabs.com', 'edgex.zunkireelabs.com'],
  ignoredHosts: ['supreme-court.zunkireelabs.com'],
};

describe('normalizeUrlKey', () => {
  test('a trailing slash or www is never a different page', () => {
    const key = 'example.com/blog';
    assert.equal(normalizeUrlKey('https://example.com/blog'), key);
    assert.equal(normalizeUrlKey('https://example.com/blog/'), key);
    assert.equal(normalizeUrlKey('https://www.example.com/blog'), key);
    assert.equal(normalizeUrlKey('http://example.com/blog//'), key);
    assert.equal(normalizeUrlKey('https://EXAMPLE.com/blog'), key);
  });

  test('the query string is dropped but the path is case-preserved', () => {
    assert.equal(normalizeUrlKey('https://example.com/Blog?utm_source=x'), 'example.com/Blog');
  });

  test('a bare root normalises to / rather than empty', () => {
    assert.equal(normalizeUrlKey('https://example.com'), 'example.com/');
    assert.equal(normalizeUrlKey('https://example.com/'), 'example.com/');
  });

  test('a malformed row falls back to the raw string instead of throwing', () => {
    assert.equal(normalizeUrlKey('not a url'), 'not a url');
    assert.equal(normalizeUrlKey(null), '');
    assert.equal(normalizeUrlKey(undefined), '');
  });
});

describe('hostOf', () => {
  test('strips www and lowercases; null on anything unparseable', () => {
    assert.equal(hostOf('https://WWW.Example.com/x'), 'example.com');
    assert.equal(hostOf('https://dev-web.zunkireelabs.com/a/b'), 'dev-web.zunkireelabs.com');
    assert.equal(hostOf('garbage'), null);
  });
});

describe('classifyHost', () => {
  test('the site itself and its declared own subdomain are own', () => {
    assert.equal(classifyHost('https://zunkireelabs.com/blog/', SITE), 'own');
    assert.equal(classifyHost('https://www.zunkireelabs.com/', SITE), 'own');
    assert.equal(classifyHost('https://edgex.zunkireelabs.com/login', SITE), 'own');
  });

  test('a recorded exclusion is ignored, not unexpected — it has been triaged', () => {
    assert.equal(classifyHost('https://supreme-court.zunkireelabs.com/web/', SITE), 'ignored');
  });

  test('an untriaged subdomain of the same root domain is unexpected', () => {
    // The whole point: sharing a root domain must NOT imply "ours".
    assert.equal(classifyHost('https://dev-web.zunkireelabs.com/ai-agents/', SITE), 'unexpected');
    assert.equal(classifyHost('https://admin-cms.zunkireelabs.com/', SITE), 'unexpected');
    assert.equal(classifyHost('https://knsewa-dev.zunkireelabs.com/', SITE), 'unexpected');
  });

  test('ownDomains is matched on equality, never as a suffix', () => {
    // 'notzunkireelabs.com' ends with nothing of ours, but a naive
    // endsWith('zunkireelabs.com') check would have matched this.
    assert.equal(classifyHost('https://evilzunkireelabs.com/', SITE), 'unexpected');
    // And a sub-subdomain of an own domain is still not that own domain.
    assert.equal(classifyHost('https://a.edgex.zunkireelabs.com/', SITE), 'unexpected');
  });

  test('tolerates own domains stored with a scheme or trailing slash', () => {
    // Live rows really do hold 'https://admizzeducation.com/' in this column.
    const messy = { ownDomains: ['https://admizzeducation.com/'], ignoredHosts: [] };
    assert.equal(classifyHost('https://admizzeducation.com/courses', messy), 'own');
    assert.equal(classifyHost('https://www.admizzeducation.com/', messy), 'own');
  });

  test('no own domain configured means pass everything through as own', () => {
    // Otherwise a site that has not finished onboarding would have its entire
    // index reported as unexpected on the first run.
    assert.equal(classifyHost('https://anything.com/', { ownDomains: [], ignoredHosts: [] }), 'own');
    assert.equal(classifyHost('https://anything.com/', {}), 'own');
    assert.equal(classifyHost('https://anything.com/'), 'own');
  });

  test('an unparseable URL gets its own bucket rather than defaulting to own', () => {
    assert.equal(classifyHost('::::', SITE), 'unparseable');
  });
});

describe('isTombstoned', () => {
  const tombstones = ['https://zunkireelabs.com/home-legacy/'];

  test('matches regardless of trailing slash or www', () => {
    assert.equal(isTombstoned('https://zunkireelabs.com/home-legacy/', tombstones), true);
    assert.equal(isTombstoned('https://zunkireelabs.com/home-legacy', tombstones), true);
    assert.equal(isTombstoned('https://www.zunkireelabs.com/home-legacy', tombstones), true);
  });

  test('does not match a different page or a prefix of one', () => {
    assert.equal(isTombstoned('https://zunkireelabs.com/home', tombstones), false);
    assert.equal(isTombstoned('https://zunkireelabs.com/home-legacy-2/', tombstones), false);
    assert.equal(isTombstoned('https://other.com/home-legacy/', tombstones), false);
  });

  test('an empty list tombstones nothing', () => {
    assert.equal(isTombstoned('https://zunkireelabs.com/home-legacy/', []), false);
    assert.equal(isTombstoned('https://zunkireelabs.com/home-legacy/', undefined), false);
  });
});

describe('classifyProbe', () => {
  test('only an explicit 404/410 is dead', () => {
    assert.equal(classifyProbe({ status: 404 }), 'dead');
    assert.equal(classifyProbe({ status: 410 }), 'dead');
  });

  test('no answer is never dead — this is the 87-false-positive case', () => {
    // A 15s timeout against one slow host produced 87 "dead" URLs that were
    // all 200 OK on a 45s retry. Absence of an answer is not evidence of
    // absence, so none of these may ever be reported as a 404.
    assert.equal(classifyProbe({ status: null, error: 'This operation was aborted' }), 'unknown');
    assert.equal(classifyProbe({ status: null }), 'unknown');
    assert.equal(classifyProbe(null), 'unknown');
    assert.equal(classifyProbe(undefined), 'unknown');
  });

  test('a 5xx is the server having a bad day, not a deleted page', () => {
    assert.equal(classifyProbe({ status: 500 }), 'unknown');
    assert.equal(classifyProbe({ status: 502 }), 'unknown');
    assert.equal(classifyProbe({ status: 503 }), 'unknown');
  });

  test('a gated page exists', () => {
    assert.equal(classifyProbe({ status: 401 }), 'blocked');
    assert.equal(classifyProbe({ status: 403 }), 'blocked');
  });

  test('ok and redirect are distinguished', () => {
    assert.equal(classifyProbe({ status: 200 }), 'ok');
    assert.equal(classifyProbe({ status: 200, redirected: true }), 'redirect');
    assert.equal(classifyProbe({ status: 301, redirected: true }), 'redirect');
  });
});

describe('hasNoindexSignal', () => {
  test('detects the reverse-proxy response header', () => {
    assert.equal(hasNoindexSignal({ headers: { 'x-robots-tag': 'noindex, nofollow' } }), true);
    assert.equal(hasNoindexSignal({ headers: { 'X-Robots-Tag': 'NOINDEX' } }), true);
  });

  test('detects the framework meta tag', () => {
    assert.equal(hasNoindexSignal({ html: '<meta name="robots" content="noindex"/>' }), true);
    assert.equal(hasNoindexSignal({ html: "<meta name='robots' content='noindex, follow'>" }), true);
  });

  test('a robots directive that is not noindex does not count', () => {
    assert.equal(hasNoindexSignal({ headers: { 'x-robots-tag': 'nofollow' } }), false);
    assert.equal(hasNoindexSignal({ html: '<meta name="robots" content="index, follow">' }), false);
  });

  test('noindex on a different meta tag is not a robots directive', () => {
    // Must not fire on an unrelated tag that merely contains the word.
    assert.equal(hasNoindexSignal({ html: '<meta name="description" content="how to noindex a page">' }), false);
  });

  test('absent signals are false, not throwing', () => {
    assert.equal(hasNoindexSignal({}), false);
    assert.equal(hasNoindexSignal(), false);
    assert.equal(hasNoindexSignal({ headers: {}, html: '' }), false);
  });
});

describe('isHandledByOffsiteRedirect', () => {
  test('the real zenly case — a 308 to the product\'s own domain is already handled', () => {
    // Found by dry-running this agent: zenly.zunkireelabs.com 308s to
    // zennly.io. That is the BETTER fix (it moves the ranking signal rather
    // than discarding it), and the first version of this file flagged it as a
    // problem because it only looked for a noindex signal.
    assert.equal(isHandledByOffsiteRedirect({
      url: 'https://zenly.zunkireelabs.com/',
      finalUrl: 'https://zennly.io/',
      redirected: true,
      status: 200,
    }), true);
  });

  test('a redirect to the site\'s own main host also counts as handled', () => {
    // Also a consolidation, also the right outcome — not something to report.
    assert.equal(isHandledByOffsiteRedirect({
      url: 'https://old.zunkireelabs.com/',
      finalUrl: 'https://zunkireelabs.com/',
      redirected: true,
      status: 200,
    }), true);
  });

  test('an internal path redirect on the SAME host is not handled', () => {
    // edgex 307s to /login on itself — it still serves content on that host,
    // so it must stay reportable.
    assert.equal(isHandledByOffsiteRedirect({
      url: 'https://edgex.zunkireelabs.com/',
      finalUrl: 'https://edgex.zunkireelabs.com/login',
      redirected: true,
      status: 200,
    }), false);
  });

  test('a host serving content directly is not handled', () => {
    assert.equal(isHandledByOffsiteRedirect({
      url: 'https://dev-web.zunkireelabs.com/',
      finalUrl: 'https://dev-web.zunkireelabs.com/',
      redirected: false,
      status: 200,
    }), false);
  });

  test('a www-only difference is not a real move', () => {
    // hostOf strips www, so this must not read as "redirected away".
    assert.equal(isHandledByOffsiteRedirect({
      url: 'https://foo.example.com/',
      finalUrl: 'https://www.foo.example.com/',
      redirected: true,
      status: 200,
    }), false);
  });

  test('missing or failed probes are never treated as handled', () => {
    assert.equal(isHandledByOffsiteRedirect(null), false);
    assert.equal(isHandledByOffsiteRedirect(undefined), false);
    assert.equal(isHandledByOffsiteRedirect({}), false);
    assert.equal(isHandledByOffsiteRedirect({ redirected: true }), false);
    assert.equal(isHandledByOffsiteRedirect({ url: 'https://a.com/', finalUrl: 'garbage', redirected: true }), false);
  });
});

describe('groupByHost', () => {
  test('aggregates URL counts and impressions per host, worst first', () => {
    const grouped = groupByHost([
      { url: 'https://a.example.com/1', impressions: 10 },
      { url: 'https://a.example.com/2', impressions: 5 },
      { url: 'https://b.example.com/1', impressions: 100 },
      { url: 'garbage', impressions: 999 },
    ]);
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped.map((g) => g.host), ['b.example.com', 'a.example.com']);
    assert.equal(grouped[1].urlCount, 2);
    assert.equal(grouped[1].impressions, 15);
  });

  test('caps sample URLs at five so evidence stays readable', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ url: `https://a.example.com/${i}`, impressions: 1 }));
    const [group] = groupByHost(rows);
    assert.equal(group.urlCount, 12);
    assert.equal(group.sampleUrls.length, 5);
  });
});

describe('buildDeadOwnUrlsFinding', () => {
  const deadUrls = [
    { url: 'https://zunkireelabs.com/gone-a/', impressions: 40, httpStatus: 404 },
    { url: 'https://zunkireelabs.com/gone-b/', impressions: 2, httpStatus: 404 },
  ];

  test('null when nothing is dead — no finding, no Action Center noise', () => {
    assert.equal(buildDeadOwnUrlsFinding({ deadUrls: [], checkedCount: 10 }), null);
    assert.equal(buildDeadOwnUrlsFinding({ deadUrls: undefined, checkedCount: 10 }), null);
  });

  test('is report-only and carries no action — the right fix is not observable', () => {
    const f = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600 });
    assert.equal(f.recommendedAction, null);
    assert.equal(f.reportOnly.kind, 'dead-indexed-url');
    // recommendations.js requires kind/label/page/whyBlocked to render a row.
    assert.ok(f.reportOnly.label);
    assert.ok(f.reportOnly.page);
    assert.ok(f.reportOnly.whyBlocked);
  });

  test('points at the highest-impression dead URL', () => {
    const f = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600 });
    assert.equal(f.reportOnly.page, 'https://zunkireelabs.com/gone-a/');
    assert.equal(f.evidence.totalImpressions, 42);
    assert.equal(f.evidence.deadCount, 2);
    assert.equal(f.evidence.checkedCount, 600);
  });

  test('traffic makes it high priority; no traffic does not', () => {
    assert.equal(buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 9 }).priority, 'high');
    const silent = [{ url: 'https://zunkireelabs.com/x/', impressions: 0, httpStatus: 404 }];
    assert.equal(buildDeadOwnUrlsFinding({ deadUrls: silent, checkedCount: 9 }).priority, 'medium');
  });

  test('reports the tombstoned count so the exclusion is visible, not silent', () => {
    const f = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600, tombstonedSkipped: 1 });
    assert.equal(f.evidence.tombstonedSkipped, 1);
    assert.match(f.whyItMatters, /ignored as intentionally deleted/);
    const none = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600 });
    assert.doesNotMatch(none.whyItMatters, /intentionally deleted/);
  });

  test('the id is stable across re-runs over the same set, and order-independent', () => {
    const a = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600 });
    const b = buildDeadOwnUrlsFinding({ deadUrls: [...deadUrls].reverse(), checkedCount: 600 });
    assert.equal(a.id, b.id);
  });

  test('a genuinely different dead set is a different finding', () => {
    const a = buildDeadOwnUrlsFinding({ deadUrls, checkedCount: 600 });
    const b = buildDeadOwnUrlsFinding({
      deadUrls: [...deadUrls, { url: 'https://zunkireelabs.com/gone-c/', impressions: 1, httpStatus: 404 }],
      checkedCount: 600,
    });
    assert.notEqual(a.id, b.id);
  });

  test('singular wording for a single URL', () => {
    const f = buildDeadOwnUrlsFinding({ deadUrls: [deadUrls[0]], checkedCount: 1 });
    assert.match(f.whyItMatters, /^1 URL on this site still appears in Google Search/);
  });
});

describe('buildUnexpectedHostsFinding', () => {
  const hosts = [
    { host: 'dev-web.zunkireelabs.com', urlCount: 31, impressions: 412, sampleUrls: ['https://dev-web.zunkireelabs.com/'] },
    { host: 'admin-cms.zunkireelabs.com', urlCount: 2, impressions: 18, sampleUrls: ['https://admin-cms.zunkireelabs.com/'] },
  ];

  test('null when every host is accounted for', () => {
    assert.equal(buildUnexpectedHostsFinding({ hosts: [] }), null);
    assert.equal(buildUnexpectedHostsFinding({ hosts: undefined }), null);
  });

  test('never actionable — a foreign URL must not be able to reach a generator', () => {
    const f = buildUnexpectedHostsFinding({ hosts });
    assert.equal(f.recommendedAction, null);
    assert.equal(f.reportOnly.kind, 'unexpected-indexed-host');
    assert.ok(f.reportOnly.whyBlocked);
  });

  test('aggregates counts and points at the worst host', () => {
    const f = buildUnexpectedHostsFinding({ hosts });
    assert.equal(f.evidence.hostCount, 2);
    assert.equal(f.evidence.totalUrls, 33);
    assert.equal(f.evidence.hosts[0].host, 'dev-web.zunkireelabs.com');
    assert.equal(f.reportOnly.page, 'https://dev-web.zunkireelabs.com/');
  });

  test('warns against robots.txt, which would freeze the pages in the index', () => {
    const f = buildUnexpectedHostsFinding({ hosts });
    assert.match(f.reportOnly.whyBlocked, /X-Robots-Tag: noindex/);
    assert.match(f.reportOnly.whyBlocked, /Do not block it in robots\.txt/);
  });

  test('the id is order-independent so a re-run dedups', () => {
    assert.equal(
      buildUnexpectedHostsFinding({ hosts }).id,
      buildUnexpectedHostsFinding({ hosts: [...hosts].reverse() }).id
    );
  });

  test('falls back to a synthetic URL when a host has no sample', () => {
    const f = buildUnexpectedHostsFinding({ hosts: [{ host: 'x.example.com', urlCount: 1, impressions: 0, sampleUrls: [] }] });
    assert.equal(f.reportOnly.page, 'https://x.example.com/');
  });
});
