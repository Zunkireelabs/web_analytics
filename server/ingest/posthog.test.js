import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { forgetHostChecks } from '../integrations/posthog-connect.js';
import {
  configured, runQuery, verifyConnection, fetchPosthogForDate, fetchDropOffs, fetchPosthogRange, fetchTopActions, humaniseEvent, actionFromRow,
} from './posthog.js';

// Three things matter here: a client's key is never thrown around or logged, a failure is RETURNED so one project's
// revoked key cannot abort a daily job serving everyone, and a metric PostHog did not return stays null.

const creds = { projectId: '123', apiKey: 'phx_secret_value', host: 'https://us.posthog.com' };
const publicDns = async () => [{ address: '203.0.113.7', family: 4 }];
const ok = (results, columns = []) => ({ ok: true, status: 200, json: async () => ({ results, columns }) });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

function spy(response) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(url, init) : response; } };
}

describe('configured', () => {
  test('all three parts are needed', () => {
    assert.equal(configured(creds), true);
    for (const missing of ['projectId', 'apiKey', 'host']) {
      assert.equal(configured({ ...creds, [missing]: '' }), false, missing);
    }
    assert.equal(configured(null), false);
  });

  test('an unconnected project is a normal state, not an error', async () => {
    const out = await runQuery(null, 'SELECT 1');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not_connected');
  });

  test('a sign-in that could not be refreshed reports ITS reason, not "not connected", and makes no request', async () => {
    const s = spy(ok([]));
    const out = await runQuery({ projectId: '1', host: 'https://us.posthog.com', apiKey: null, authError: { reason: 'unauthorized', detail: 'PostHog access was revoked or has expired.' } }, 'SELECT 1', { fetchImpl: s.fetchImpl });
    assert.deepEqual(out, { ok: false, reason: 'unauthorized', detail: 'PostHog access was revoked or has expired.' });
    assert.equal(s.calls.length, 0);
  });
});

describe('failures are returned, never thrown', () => {
  test('a revoked key is named so a person can act on it', async () => {
    for (const code of [401, 403]) {
      const out = await runQuery(creds, 'SELECT 1', spy(status(code)));
      assert.equal(out.reason, 'unauthorized');
      assert.match(out.detail, /revoked/);
    }
  });

  test('a wrong project or host is named separately', async () => {
    const out = await runQuery(creds, 'SELECT 1', spy(status(404)));
    assert.equal(out.reason, 'project_not_found');
    assert.match(out.detail, /region or self-hosted/);
  });

  test('an unreachable instance is reported, not thrown', async () => {
    const out = await runQuery(creds, 'SELECT 1', { fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
    assert.equal(out.reason, 'unreachable');
    assert.match(out.detail, /ETIMEDOUT/);
  });

  test('a non-JSON body is a failure, not a crash', async () => {
    const out = await runQuery(creds, 'SELECT 1', spy({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    assert.equal(out.reason, 'failed');
  });

  test('any other HTTP error is reported with its code', async () => {
    assert.equal((await runQuery(creds, 'SELECT 1', spy(status(500)))).reason, 'failed');
  });
});

describe('the credential', () => {
  test('is sent as a bearer token and nothing else', async () => {
    const s = spy(ok([[1]]));
    await runQuery(creds, 'SELECT 1', s);
    assert.equal(s.calls[0].init.headers.Authorization, 'Bearer phx_secret_value');
    assert.ok(!s.calls[0].url.includes('phx_secret_value'), 'the key must never appear in a URL');
  });

  test('never appears in a returned error', async () => {
    const out = await runQuery(creds, 'SELECT 1', spy(status(401)));
    assert.ok(!JSON.stringify(out).includes('phx_secret_value'));
  });

  test('the project id is encoded into the path', async () => {
    const s = spy(ok([]));
    await runQuery({ ...creds, projectId: 'a b' }, 'SELECT 1', s);
    assert.match(s.calls[0].url, /\/api\/projects\/a%20b\/query\//);
  });

  test('a self-hosted host is used as given', async () => {
    const s = spy(ok([]));
    await runQuery({ ...creds, host: 'https://ph.client.io' }, 'SELECT 1', { ...s, lookup: publicDns });
    assert.match(s.calls[0].url, /^https:\/\/ph\.client\.io\//);
  });
});

// A credential is sent to the host, so the host is checked EVERY time it is used (a stored address can start resolving
// somewhere else after it was chosen), and a redirect is never followed.
describe('the address a credential is sent to', () => {
  const publicDns = async () => [{ address: '203.0.113.7', family: 4 }];
  const inwardDns = async () => [{ address: '10.0.0.8', family: 4 }];

  test('a stored address that is http, loopback, private, link-local or has credentials is refused with NO request made', async () => {
    for (const host of ['http://ph.client.io', 'https://localhost', 'https://127.0.0.1:8000', 'https://10.1.2.3', 'https://192.168.0.9', 'https://169.254.169.254', 'https://[::1]', 'https://u:p@ph.client.io']) {
      forgetHostChecks();
      const s = spy(ok([]));
      const out = await runQuery({ ...creds, host }, 'SELECT 1', { ...s, lookup: publicDns });
      assert.deepEqual([out.ok, out.reason], [false, 'bad_host'], host);
      assert.equal(s.calls.length, 0, `${host}: nothing may be sent to it`);
    }
  });

  test('a NAME that now resolves to an internal address is refused, even though it was fine when it was saved', async () => {
    forgetHostChecks();
    const s = spy(ok([]));
    const out = await runQuery({ ...creds, host: 'https://ph.client.io' }, 'SELECT 1', { ...s, lookup: inwardDns });
    assert.equal(out.reason, 'bad_host');
    assert.equal(s.calls.length, 0);
  });

  test('PostHog\'s own cloud needs no lookup at all', async () => {
    forgetHostChecks();
    const s = spy(ok([]));
    const out = await runQuery(creds, 'SELECT 1', { ...s, lookup: async () => { throw new Error('must not be called'); } });
    assert.equal(out.ok, true);
  });

  test('every query asks fetch NOT to follow redirects, and a redirect answer is a failure (nothing is followed)', async () => {
    forgetHostChecks();
    const s = spy(ok([[1]]));
    await runQuery(creds, 'SELECT 1', s);
    assert.equal(s.calls[0].init.redirect, 'manual');
    const redirected = spy({ ok: false, status: 302, json: async () => ({}), headers: { get: () => 'http://169.254.169.254/' } });
    const out = await runQuery(creds, 'SELECT 1', redirected);
    assert.deepEqual([out.ok, out.reason], [false, 'failed']);
    assert.equal(redirected.calls.length, 1, 'the Location was not requested');
  });
});

describe('verifyConnection', () => {
  test('a working key verifies with the cheapest possible query', async () => {
    const s = spy(ok([[1]]));
    assert.deepEqual(await verifyConnection(creds, s), { ok: true });
    assert.match(s.calls[0].init.body, /SELECT 1/);
  });

  test('a bad key fails with the reason, not a bare false', async () => {
    const out = await verifyConnection(creds, spy(status(401)));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unauthorized');
  });
});

describe('fetchPosthogForDate', () => {
  test('reads the day\'s product metrics', async () => {
    const out = await fetchPosthogForDate(creds, '2026-11-05', spy(ok([[5000, 420, 3100, 610]])));
    assert.equal(out.ok, true);
    assert.deepEqual(out.totals, { events: 5000, people: 420, pageviews: 3100, sessions: 610 });
  });

  test('a metric PostHog did not return stays null, never zero', async () => {
    const out = await fetchPosthogForDate(creds, '2026-11-05', spy(ok([[5000, null, undefined, '']])));
    assert.equal(out.totals.events, 5000);
    assert.equal(out.totals.people, null);
    assert.equal(out.totals.pageviews, null);
    assert.equal(out.totals.sessions, null);
  });

  test('an empty result set does not crash', async () => {
    const out = await fetchPosthogForDate(creds, '2026-11-05', spy(ok([])));
    assert.equal(out.ok, true);
    assert.equal(out.totals.events, null);
  });

  test('a failure propagates as a failure, not as zeros', async () => {
    const out = await fetchPosthogForDate(creds, '2026-11-05', spy(status(401)));
    assert.equal(out.ok, false);
    assert.equal(out.totals, undefined, 'no fabricated totals on failure');
  });

  test('a malformed date is refused rather than interpolated into the query', async () => {
    for (const bad of ["2026-11-05'; DROP TABLE events; --", '05/11/2026', '', null]) {
      await assert.rejects(() => fetchPosthogForDate(creds, bad, spy(ok([]))), /Invalid date/, String(bad));
    }
  });
});

describe('fetchDropOffs', () => {
  test('returns the events sessions ended on, worst first', async () => {
    const out = await fetchDropOffs(creds, '2026-11-05', spy(ok([['checkout_started', 120], ['form_viewed', 40]])));
    assert.deepEqual(out.dropOffs, [
      { event: 'checkout_started', sessionsEndingHere: 120 },
      { event: 'form_viewed', sessionsEndingHere: 40 },
    ]);
  });

  test('rows with no event name are dropped', async () => {
    const out = await fetchDropOffs(creds, '2026-11-05', spy(ok([[null, 5], ['real_event', 3]])));
    assert.deepEqual(out.dropOffs.map((d) => d.event), ['real_event']);
  });

  test('the limit is clamped so a caller cannot ask for an unbounded scan', async () => {
    const s = spy(ok([]));
    await fetchDropOffs(creds, '2026-11-05', { limit: 9999, fetchImpl: s.fetchImpl });
    assert.match(s.calls[0].init.body, /LIMIT 50/);
  });

  test('a failure is returned', async () => {
    assert.equal((await fetchDropOffs(creds, '2026-11-05', spy(status(500)))).ok, false);
  });
});

describe('drop-offs ignore the events PostHog records on every visit', () => {
  test('housekeeping events are excluded from the query, so $pageleave cannot dominate', async () => {
    const s = spy(ok([]));
    await fetchDropOffs(creds, '2026-11-05', { fetchImpl: s.fetchImpl });
    const query = JSON.parse(s.calls[0].init.body).query.query;
    for (const e of ['$pageleave', '$autocapture', '$web_vitals']) assert.ok(query.includes(`'${e}'`), `${e} should be excluded`);
    assert.match(query, /NOT IN \(/);
  });

  test('a pageview is named by its path, so "where" is answerable', async () => {
    const s = spy(ok([]));
    await fetchDropOffs(creds, '2026-11-05', { fetchImpl: s.fetchImpl });
    const query = JSON.parse(s.calls[0].init.body).query.query;
    assert.match(query, /concat\('page: '/);
    assert.match(query, /\$pathname/);
  });
});

describe('fetchPosthogRange', () => {
  const totalsRows = [['2026-11-01', 100, 40, 60, 50], ['2026-11-02', 120, 45, 70, 55]];
  const dropRows = [['2026-11-01', 'page: /pricing', 9], ['2026-11-01', 'signup_form_viewed', 4], ['2026-11-02', 'page: /pricing', 12]];
  // Real HogQL row shape for the actions query: [day, event, kind, text, times].
  const actionRows = [
    ['2026-11-01', 'booking_form_started', '', '', 31], ['2026-11-01', '$autocapture', 'click', 'Book now', 55],
    ['2026-11-01', '$autocapture', 'click', '', 9], ['2026-11-02', 'booking_form_started', '', '', 40],
  ];
  const twoQueries = () => {
    let n = 0;
    return spy(() => ok([totalsRows, dropRows, actionRows][Math.min(n++, 2)]));
  };

  test('many days come back from three queries, not one per day', async () => {
    const s = twoQueries();
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: s.fetchImpl });
    assert.equal(s.calls.length, 3);
    assert.deepEqual(out.days.map((d) => d.date), ['2026-11-01', '2026-11-02']);
    assert.deepEqual(out.days[0].totals, { events: 100, people: 40, pageviews: 60, sessions: 50 });
  });

  test('each day carries its own drop-offs, worst first', async () => {
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: twoQueries().fetchImpl });
    assert.deepEqual(out.days[0].dropOffs, [
      { event: 'page: /pricing', sessionsEndingHere: 9 },
      { event: 'signup_form_viewed', sessionsEndingHere: 4 },
    ]);
  });

  test('each day carries its own actions, biggest first, and an unnamed click is left out', async () => {
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: twoQueries().fetchImpl });
    assert.deepEqual(out.days[0].topActions, [
      { label: 'Clicked \u201cBook now\u201d', raw: null, times: 55 },
      { label: 'Booking form started', raw: 'booking_form_started', times: 31 },
    ]);
    assert.deepEqual(out.days[1].topActions, [{ label: 'Booking form started', raw: 'booking_form_started', times: 40 }]);
  });

  test('an actions failure does not cost the totals or the drop-offs', async () => {
    let n = 0;
    const s = spy(() => (n++ === 2 ? status(500) : ok(n === 1 ? totalsRows : dropRows)));
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: s.fetchImpl });
    assert.equal(out.ok, true);
    assert.equal(out.actionsAvailable, false);
    assert.equal(out.dropOffsAvailable, true);
    assert.equal(out.days[0].topActions.length, 0);
    assert.equal(out.days[0].dropOffs.length, 2);
  });

  test('the actions query caps PER DAY with a window, never one global LIMIT that would cut off the newest days', async () => {
    const s = twoQueries();
    await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: s.fetchImpl });
    const q = JSON.parse(s.calls[2].init.body).query.query;
    assert.match(q, /row_number\(\) OVER \(PARTITION BY d ORDER BY times DESC\)/);
    assert.match(q, /WHERE rn <= 50/);
    assert.ok(!/LIMIT 20000/.test(q), 'a global limit ordered by day drops the most recent days of a busy site');
    assert.ok(!/ORDER BY d, times DESC\s+LIMIT (?!10000)/.test(q));
  });

  test('every requested day keeps its own actions, including the most recent ones, however many rows the earlier days have', async () => {
    // 20 days, 40 distinct actions each: 800 rows. A global cut would have lost the tail; per-day capping keeps every day.
    const days = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
    const totals = days.map((d) => [d, 100, 10, 60, 50]);
    const acts = days.flatMap((d) => Array.from({ length: 40 }, (_, k) => [d, `event_${k}`, '', '', 100 - k]));
    let n = 0;
    const s = spy(() => ok([totals, [], acts][Math.min(n++, 2)]));
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-20', { fetchImpl: s.fetchImpl });
    assert.equal(out.days.length, 20);
    for (const day of out.days) assert.equal(day.topActions.length, 15, `${day.date} must keep its own top 15`);
    assert.equal(out.days.at(-1).topActions[0].raw, 'event_0');
  });

  test('a day with no events is simply absent, never stored as zero', async () => {
    const s = spy(() => ok([['2026-11-01', 100, 40, 60, 50]]));
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-03', { fetchImpl: s.fetchImpl });
    assert.deepEqual(out.days.map((d) => d.date), ['2026-11-01']);
  });

  test('a drop-off failure does not cost the totals that already arrived', async () => {
    let n = 0;
    const s = spy(() => (n++ === 0 ? ok(totalsRows) : status(500)));
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', { fetchImpl: s.fetchImpl });
    assert.equal(out.ok, true);
    assert.equal(out.days.length, 2);
    assert.equal(out.dropOffsAvailable, false);
  });

  test('a failing totals query is returned as a failure', async () => {
    const out = await fetchPosthogRange(creds, '2026-11-01', '2026-11-02', spy(status(401)));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unauthorized');
  });

  test('a backwards or oversized range is refused before any request', async () => {
    const s = spy(ok([]));
    await assert.rejects(() => fetchPosthogRange(creds, '2026-11-05', '2026-11-01', { fetchImpl: s.fetchImpl }), /Invalid range/);
    await assert.rejects(() => fetchPosthogRange(creds, '2026-01-01', '2026-11-01', { fetchImpl: s.fetchImpl }), /120 days/);
    assert.equal(s.calls.length, 0);
  });

  test('a malformed date is refused, not interpolated', async () => {
    await assert.rejects(() => fetchPosthogRange(creds, "2026-11-01'; --", '2026-11-02', spy(ok([]))), /Invalid date/);
  });
});

describe('what visitors did (clicks and form steps)', () => {
  test('a custom event is made readable and keeps its raw name', () => {
    assert.deepEqual(actionFromRow(['booking_form_started', '', '', 12]), { label: 'Booking form started', raw: 'booking_form_started', times: 12 });
    assert.equal(humaniseEvent('signupCompleted'), 'Signup completed');
    assert.equal(humaniseEvent('$feature_view'), 'Feature view');
    assert.equal(humaniseEvent('played-intro.video'), 'Played intro video');
  });

  test('a click is named by its text; one with no text, or a whole block of text, cannot be named and is dropped', () => {
    assert.deepEqual(actionFromRow(['$autocapture', 'click', '  Book   now ', 7]), { label: 'Clicked \u201cBook now\u201d', raw: null, times: 7 });
    assert.equal(actionFromRow(['$autocapture', 'click', '', 7]), null);
    assert.equal(actionFromRow(['$autocapture', 'click', 'x'.repeat(61), 7]), null);
    assert.equal(actionFromRow(['$autocapture', 'change', 'Subscribe', 7]), null);
  });

  test('a form submit never carries the form text (it is the whole form, and could hold anything)', () => {
    assert.deepEqual(actionFromRow(['$autocapture', 'submit', 'Name Email jane@example.com Message hello', 3]), { label: 'Submitted a form', raw: null, times: 3 });
  });

  test('control characters in element text are stripped, not stored', () => {
    assert.equal(actionFromRow(['$autocapture', 'click', 'Book\u0000\nnow', 1]).label, 'Clicked \u201cBook now\u201d');
  });

  test('nothing is counted for a row that has no count', () => {
    assert.equal(actionFromRow(['booking_form_started', '', '', null]), null);
    assert.equal(actionFromRow(['booking_form_started', '', '', 0]), null);
    assert.equal(actionFromRow(['', '', '', 5]), null);
  });

  test('the same label from two buttons is added up, biggest first, capped', async () => {
    const rows = [['$autocapture', 'click', 'Book now', 5], ['$autocapture', 'click', 'Book now', 8], ['faq_opened', '', '', 9], ['a', '', '', 1], ['b', '', '', 2]];
    const out = await fetchTopActions(creds, '2026-11-05', { limit: 3, fetchImpl: spy(ok(rows)).fetchImpl });
    assert.deepEqual(out.topActions.map((a) => [a.label, a.times]), [['Clicked \u201cBook now\u201d', 13], ['Faq opened', 9], ['B', 2]]);
  });

  test('housekeeping events and pageviews are excluded, but clicks are kept', async () => {
    const s = spy(ok([]));
    await fetchTopActions(creds, '2026-11-05', { fetchImpl: s.fetchImpl });
    const q = JSON.parse(s.calls[0].init.body).query.query;
    for (const e of ['$pageleave', '$pageview', '$web_vitals']) assert.ok(q.includes(`'${e}'`), `${e} should be excluded`);
    assert.ok(!/NOT IN \([^)]*'\$autocapture'/.test(q), 'autocapture is the source of clicks, so it must not be excluded');
  });

  test('the date is validated before it is interpolated, and a failure is returned', async () => {
    await assert.rejects(() => fetchTopActions(creds, "2026-11-05'; --", { fetchImpl: spy(ok([])).fetchImpl }), /Invalid date/);
    const out = await fetchTopActions(creds, '2026-11-05', { fetchImpl: spy(status(401)).fetchImpl });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'unauthorized');
  });
});
