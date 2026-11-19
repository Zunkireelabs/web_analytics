import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIp, parseCidr, makeMatcher, isNonPublicIp } from './ip-match.js';
import { parseLine, parseLogTime, clientAddress, cleanPath } from './parse-log.js';
import { classifyUserAgent, BOTS, botById } from './bots.js';
import { parseRangesJson, loadRangeLists, compileRanges, verifyVisit, LIST_URLS } from './verify.js';
import { aggregateLines, applyDailyPathCap, OTHER_PATH } from './aggregate.js';
import { REAL_BOT, REAL_META, REAL_OWN, SLUG_VISITOR, SEARCHBOT_JSON, ANTHROPIC_JSON, GOOGLE_JSON } from './fixtures.js';

const lists = () => ({
  'openai-searchbot': parseRangesJson(SEARCHBOT_JSON),
  anthropic: parseRangesJson(ANTHROPIC_JSON),
  'google-common': parseRangesJson(GOOGLE_JSON),
});

describe('ip matching', () => {
  test('IPv4 inside and outside a CIDR, including the edges', () => {
    const m = makeMatcher(['51.8.102.0/24']);
    assert.equal(m('51.8.102.237'), true);
    assert.equal(m('51.8.102.0'), true);
    assert.equal(m('51.8.102.255'), true);
    assert.equal(m('51.8.103.0'), false);
    assert.equal(m('51.8.101.255'), false);
  });
  test('a /32 matches only that address, a bare address is a /32', () => {
    assert.equal(makeMatcher(['34.162.230.222/32'])('34.162.230.222'), true);
    assert.equal(makeMatcher(['34.162.230.222/32'])('34.162.230.223'), false);
    assert.equal(makeMatcher(['34.162.230.222'])('34.162.230.222'), true);
  });
  test('IPv6 inside and outside, with compressed forms', () => {
    const m = makeMatcher(['2001:4860:4801:10::/64']);
    assert.equal(m('2001:4860:4801:10::1'), true);
    assert.equal(m('2001:4860:4801:10:ffff:ffff:ffff:ffff'), true);
    assert.equal(m('2001:4860:4801:11::1'), false);
    assert.equal(m('::1'), false);
  });
  test('an IPv4-mapped IPv6 address is read as its IPv4', () => {
    assert.equal(makeMatcher(['51.8.102.0/24'])('::ffff:51.8.102.5'), true);
    assert.deepEqual(parseIp('::ffff:1.2.3.4'), parseIp('1.2.3.4'));
  });
  test('IPv4 and IPv6 never match each other', () => {
    assert.equal(makeMatcher(['0.0.0.0/0'])('2001:db8::1'), false);
    assert.equal(makeMatcher(['::/0'])('1.2.3.4'), false);
  });
  test('invalid input is rejected, never matched', () => {
    for (const bad of ['', null, 'abc', '999.1.1.1', '1.2.3', '1.2.3.4.5', '2001:::1', '12345::']) assert.equal(parseIp(bad), null, String(bad));
    for (const bad of ['1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4/x', '1.2.3.4/8/8', '::/129', 'nope/8']) assert.equal(parseCidr(bad), null, String(bad));
    assert.equal(makeMatcher(['1.2.3.0/24'])('not an ip'), false);
  });
  test('private, loopback and link-local addresses are non-public', () => {
    for (const ip of ['10.1.2.3', '172.18.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) assert.equal(isNonPublicIp(ip), true, ip);
    for (const ip of ['51.8.102.237', '172.32.0.1', '8.8.8.8', '2001:4860:4801:10::1']) assert.equal(isNonPublicIp(ip), false, ip);
  });
});

describe('log parsing (real lines)', () => {
  test('a real nginx line from the server: time, path, status, user agent, and the address behind the proxy', () => {
    const r = parseLine(REAL_BOT);
    assert.equal(r.day, '2026-11-17');
    assert.equal(r.at.toISOString(), '2026-11-17T19:28:09.000Z');
    assert.equal(r.method, 'GET');
    assert.equal(r.path, '/robots.txt');
    assert.equal(r.status, 200);
    assert.equal(r.bytes, 650);
    assert.match(r.userAgent, /OAI-SearchBot\/1\.0/);
    assert.equal(r.clientIp, '51.8.102.237'); // not the proxy's 172.18.0.3
  });
  test('Apache combined format (no forwarded field): the first field is the visitor', () => {
    const r = parseLine('66.249.66.1 - - [10/Oct/2026:13:55:36 -0700] "GET /a HTTP/1.1" 404 209 "-" "GPTBot/1.4"');
    assert.equal(r.clientIp, '66.249.66.1');
    assert.equal(r.at.toISOString(), '2026-10-10T20:55:36.000Z'); // -0700 applied: the UTC day can differ from the log's
    assert.equal(r.status, 404);
  });
  test('the UTC day follows the offset in the line', () => {
    assert.equal(parseLine('1.1.1.1 - - [01/Dec/2026:00:30:00 +0545] "GET / HTTP/1.1" 200 1 "-" "x"').day, '2026-11-30'); // Nepal time
    assert.equal(parseLogTime('01/Xyz/2026:00:00:00 +0000'), null);
  });
  test('query strings are dropped (they hold tokens and personal data), paths are capped, control characters removed', () => {
    assert.equal(parseLine('1.1.1.1 - - [01/Dec/2026:00:00:00 +0000] "GET /p?email=a@b.com&token=SECRET HTTP/1.1" 200 1 "-" "x"').path, '/p');
    assert.equal(cleanPath('/a#frag'), '/a');
    assert.equal(cleanPath('/' + 'x'.repeat(500)).length, 200);
    assert.equal(cleanPath('/a\u0000b\u001f'), '/ab');
  });
  test('X-Forwarded-For: the LAST entry is the real visitor, earlier ones can be forged', () => {
    assert.equal(clientAddress('172.18.0.3', '8.8.8.8, 51.8.102.237'), '51.8.102.237');
    assert.equal(clientAddress('172.18.0.3', '51.8.102.237:4433'), '51.8.102.237');
    assert.equal(clientAddress('172.18.0.3', '[2001:4860:4801:10::1]:443'), '2001:4860:4801:10::1');
    assert.equal(clientAddress('1.2.3.4', '-'), '1.2.3.4');
    assert.equal(clientAddress('1.2.3.4', undefined), '1.2.3.4');
    assert.equal(clientAddress('172.18.0.3', 'unknown'), null); // present but unreadable: never fall back to a guess
    assert.equal(clientAddress('172.18.0.3', ', ,'), null);
  });
  test('garbage and non-request lines are skipped, not guessed at', () => {
    for (const bad of ['', '   ', 'not a log line', '1.1.1.1 - - [bad time] "GET / HTTP/1.1" 200 1 "-" "x"',
      '1.1.1.1 - - [01/Dec/2026:00:00:00 +0000] "\\x16\\x03\\x01" 400 1 "-" "x"', // TLS bytes sent to a plain port
      '1.1.1.1 - - [01/Dec/2026:00:00:00 +0000] "-" 408 0 "-" "-"',
      '1.1.1.1 - - [01/Dec/2026:00:00:00 +0000] "GET nopath HTTP/1.1" 200 1 "-" "x"',
      '1.1.1.1 - - [01/Dec/2026:00:00:00 +0000] "GET / HTTP/1.1" 200']) {
      assert.equal(parseLine(bad), null, JSON.stringify(bad));
    }
  });
});

describe('bot recognition', () => {
  test('every tracked bot is recognised from its documented user-agent token', () => {
    const uas = {
      gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
      'oai-searchbot': 'Mozilla/5.0 ... compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
      'chatgpt-user': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
      claudebot: 'ClaudeBot/1.0', 'claude-searchbot': 'Claude-SearchBot', 'claude-user': 'Claude-User',
      perplexitybot: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      'perplexity-user': 'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
      'google-cloudvertexbot': 'Mozilla/5.0 Google-CloudVertexBot', googleother: 'Mozilla/5.0 (compatible; GoogleOther) Chrome/1 Safari/537.36',
      'google-agent': 'Mozilla/5.0 Google-Agent',
      googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      applebot: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
      bytespider: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
      'meta-externalagent': 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
      'meta-externalfetcher': 'meta-externalfetcher/1.1', 'meta-webindexer': 'Mozilla/5.0 (compatible; meta-webindexer/1.1)',
    };
    assert.deepEqual(Object.keys(uas).sort(), BOTS.map((b) => b.id).sort(), 'the test must cover every bot in the list');
    for (const [id, ua] of Object.entries(uas)) assert.equal(classifyUserAgent(ua)?.bot?.id, id, id);
  });
  test('the real user agents from the server line up: OAI-SearchBot, meta-webindexer, our own agent', () => {
    assert.equal(classifyUserAgent(parseLine(REAL_BOT).userAgent).bot.id, 'oai-searchbot');
    assert.equal(classifyUserAgent(parseLine(REAL_META).userAgent).bot.id, 'meta-webindexer');
    assert.deepEqual(classifyUserAgent(parseLine(REAL_OWN).userAgent), { own: true });
  });
  test('names that are only part of something else do not count', () => {
    for (const ua of ['NotGPTBot/1.0', 'GPTBot-test/1.0', 'SuperClaudeBot', 'Applebot-Extended', 'Mozilla/5.0 Chrome/131.0 Safari/537.36', 'Googlebot-Image/1.0', 'Googlebot-News', '', '-', null, undefined]) {
      assert.equal(classifyUserAgent(ua), null, String(ua));
    }
  });
  test('Googlebot is tracked but flagged as NOT an AI crawler, so the dashboard can keep it out of the AI totals', () => {
    assert.equal(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').bot.ai, false);
    assert.deepEqual(BOTS.filter((b) => !b.ai).map((b) => b.id), ['googlebot']);
    assert.equal(botById('gptbot').ai, true);
    assert.equal(botById('googleother').ai, true);
  });
  test('Googlebot verifies against Google\'s list like any other crawler', () => {
    assert.equal(verifyVisit(botById('googlebot'), '66.249.64.5', compileRanges(lists())), 'verified');
    assert.equal(verifyVisit(botById('googlebot'), '8.8.8.8', compileRanges(lists())), 'unverified');
  });
  test('ClaudeBot and Claude-User are different bots', () => {
    assert.equal(classifyUserAgent('Claude-User').bot.id, 'claude-user');
    assert.equal(classifyUserAgent('ClaudeBot/1.0').bot.id, 'claudebot');
  });
  test('botById finds an entry, and every list a bot points at has a URL', () => {
    assert.equal(botById('gptbot').vendor, 'OpenAI');
    assert.equal(botById('nope'), null);
    for (const b of BOTS) assert.ok(b.list === null || LIST_URLS[b.list], `${b.id} points at a list with no URL`);
  });
});

describe('vendor lists and verification', () => {
  test('real list shapes parse; IPv6 entries are kept; bad entries are dropped', () => {
    assert.deepEqual(parseRangesJson(GOOGLE_JSON).cidrs, ['2001:4860:4801:10::/64', '66.249.64.0/27']);
    assert.equal(parseRangesJson(ANTHROPIC_JSON).creationTime, '2026-10-20T00:00:00Z');
    const mixed = parseRangesJson(JSON.stringify({ prefixes: [{ ipv4Prefix: '1.2.3.0/24' }, { ipv4Prefix: 'junk' }, {}, null, { ipv4Prefix: 5 }] }));
    assert.deepEqual(mixed.cidrs, ['1.2.3.0/24']);
  });
  test('a list that is garbage or empty is a FAILURE, so it can never turn every real visit into "unverified"', () => {
    for (const bad of ['', 'not json', '{}', '{"prefixes":"x"}', '{"prefixes":[]}', '{"prefixes":[{"ipv4Prefix":"junk"}]}', 'null']) assert.equal(parseRangesJson(bad).ok, false, bad);
  });
  test('the real OAI-SearchBot visit from the server verifies; the same user agent from elsewhere does not', () => {
    const ranges = compileRanges(lists());
    const bot = botById('oai-searchbot');
    assert.equal(verifyVisit(bot, '51.8.102.237', ranges), 'verified');
    assert.equal(verifyVisit(bot, '8.8.8.8', ranges), 'unverified');
    assert.equal(verifyVisit(bot, null, ranges), 'unverified');
    assert.equal(verifyVisit(bot, '172.18.0.1', ranges), 'unverified'); // a private address is never a vendor
  });
  test('Anthropic: one combined list covers all three of its bots', () => {
    const ranges = compileRanges(lists());
    for (const id of ['claudebot', 'claude-user', 'claude-searchbot']) {
      assert.equal(verifyVisit(botById(id), '216.73.217.5', ranges), 'verified', id);
      assert.equal(verifyVisit(botById(id), '216.73.220.1', ranges), 'unverified', id);
    }
  });
  test('Google over IPv6 verifies', () => {
    assert.equal(verifyVisit(botById('googleother'), '2001:4860:4801:10::beef', compileRanges(lists())), 'verified');
  });
  test('a vendor with no published list, or a list we failed to load, is "unchecked", never "unverified"', () => {
    const ranges = compileRanges(lists());
    assert.equal(verifyVisit(botById('bytespider'), '1.2.3.4', ranges), 'unchecked');
    assert.equal(verifyVisit(botById('meta-webindexer'), '57.141.20.79', ranges), 'unchecked');
    assert.equal(verifyVisit(botById('gptbot'), '1.2.3.4', ranges), 'unchecked'); // its list is not among those loaded
    assert.equal(verifyVisit(botById('oai-searchbot'), '8.8.8.8', compileRanges({ 'openai-searchbot': { ok: false, error: 'HTTP 503' } })), 'unchecked');
    assert.equal(verifyVisit(botById('oai-searchbot'), '8.8.8.8', compileRanges(undefined)), 'unchecked');
  });
  test('loadRangeLists: one failing list (HTTP error, bad JSON, timeout) never affects the others', async () => {
    const answers = {
      [LIST_URLS['openai-searchbot']]: { ok: true, text: SEARCHBOT_JSON },
      [LIST_URLS.anthropic]: { ok: false, status: 503 },
      [LIST_URLS['openai-gptbot']]: { ok: true, text: '<html>blocked</html>' },
      [LIST_URLS.apple]: { throws: 'The operation was aborted due to timeout', name: 'TimeoutError' }, // the real shape of AbortSignal.timeout()
    };
    const fetchImpl = async (url) => {
      const a = answers[url];
      if (!a) return { ok: true, status: 200, text: async () => SEARCHBOT_JSON };
      if (a.throws) throw Object.assign(new Error(a.throws), a.name ? { name: a.name } : {});
      return { ok: a.ok, status: a.status || 200, text: async () => a.text };
    };
    const out = await loadRangeLists({ fetchImpl });
    assert.equal(out['openai-searchbot'].ok, true);
    assert.equal(out.anthropic.ok, false);
    assert.equal(out.anthropic.error, 'server error');
    assert.equal(out['openai-gptbot'].ok, false);
    assert.equal(out.apple.error, 'network error'); // a safe category, never the raw exception text
    assert.doesNotMatch(out.apple.error, /aborted/);
    assert.deepEqual(Object.keys(out).sort(), Object.keys(LIST_URLS).sort());
    JSON.parse(JSON.stringify(out)); // plain data: safe to cache as JSON
  });
});

describe('aggregation', () => {
  const ranges = () => compileRanges(lists());
  test('the real server lines: one verified OAI-SearchBot visit, Meta unchecked, our own agent left out, the slug visitor ignored', () => {
    const { rows, stats } = aggregateLines([REAL_BOT, REAL_META, REAL_OWN, SLUG_VISITOR], { ranges: ranges() });
    assert.deepEqual(rows, [
      { day: '2026-11-17', botId: 'meta-webindexer', path: '/blog/robots-txt-for-ai-crawlers-gptbot-claudebot-perplexitybot', status: 200, verification: 'unchecked', hits: 1 },
      { day: '2026-11-17', botId: 'oai-searchbot', path: '/robots.txt', status: 200, verification: 'verified', hits: 1 },
    ]);
    assert.equal(stats.ownExcluded, 1);
    assert.equal(stats.notBot, 1); // the human who read the post whose address contains the bot names
    assert.equal(stats.botVisits, 2);
  });
  test('the same visit repeated is counted each time; different status codes are separate rows', () => {
    const ok = REAL_BOT;
    const notFound = REAL_BOT.replace('" 200 650', '" 404 650');
    const { rows } = aggregateLines([ok, ok, ok, notFound], { ranges: ranges() });
    assert.deepEqual(rows.map((r) => [r.status, r.hits]), [[200, 3], [404, 1]]);
  });
  test('a fake GPTBot from a random address is counted as unverified, not as GPTBot', () => {
    const line = '172.18.0.3 - - [17/Nov/2026:19:00:00 +0000] "GET /pricing HTTP/1.1" 200 5 "-" "Mozilla/5.0; compatible; OAI-SearchBot/1.0" "8.8.8.8"';
    const { rows, stats } = aggregateLines([line], { ranges: ranges() });
    assert.equal(rows[0].verification, 'unverified');
    assert.deepEqual(stats.byVerification, { verified: 0, unverified: 1, unchecked: 0 });
  });
  test('NO visitor address appears anywhere in the output, and no query string', () => {
    const withQuery = REAL_BOT.replace('/robots.txt', '/p?email=leak@example.com');
    const { rows, stats } = aggregateLines([REAL_BOT, REAL_META, withQuery], { ranges: ranges() });
    const text = JSON.stringify({ rows, stats });
    for (const secret of ['51.8.102.237', '57.141.20.79', '172.18.0.3', 'leak@example.com', 'email=']) assert.equal(text.includes(secret), false, secret);
  });
  test('the day is the UTC day; lines either side of midnight land on different days', () => {
    const a = REAL_BOT.replace('17/Nov/2026:19:28:09 +0000', '17/Nov/2026:23:59:59 +0000');
    const b = REAL_BOT.replace('17/Nov/2026:19:28:09 +0000', '18/Nov/2026:00:00:01 +0000');
    assert.deepEqual(aggregateLines([a, b], { ranges: ranges() }).rows.map((r) => r.day), ['2026-11-17', '2026-11-18']);
  });
  test('a crawler loop cannot grow storage: past the per-day path cap, new paths fold into "(other)" and totals stay true', () => {
    const lines = Array.from({ length: 50 }, (_, i) => REAL_BOT.replace('/robots.txt', `/loop/${i}`));
    const { rows, stats } = aggregateLines(lines, { ranges: ranges(), maxPathsPerDay: 10 });
    assert.equal(rows.length, 11); // 10 real paths + (other)
    assert.equal(rows.find((r) => r.path === OTHER_PATH).hits, 40);
    assert.equal(rows.reduce((n, r) => n + r.hits, 0), 50);
    assert.equal(stats.pathsFolded, 40);
    // an already-seen path keeps its own row even after the cap is reached
    const again = aggregateLines([...lines.slice(0, 10), ...lines.slice(0, 10), REAL_BOT.replace('/robots.txt', '/new')], { ranges: ranges(), maxPathsPerDay: 10 });
    assert.equal(again.rows.find((r) => r.path === '/loop/0').hits, 2);
    assert.equal(again.rows.find((r) => r.path === OTHER_PATH).hits, 1);
  });
  test('the path cap is per day, so a busy day does not starve the next', () => {
    const day1 = Array.from({ length: 5 }, (_, i) => REAL_BOT.replace('/robots.txt', `/a/${i}`));
    const day2 = Array.from({ length: 5 }, (_, i) => REAL_BOT.replace('17/Nov', '18/Nov').replace('/robots.txt', `/b/${i}`));
    const { rows } = aggregateLines([...day1, ...day2], { ranges: ranges(), maxPathsPerDay: 5 });
    assert.equal(rows.some((r) => r.path === OTHER_PATH), false);
  });
  test('bad lines are counted, never thrown on; empty input is fine; output order is stable', () => {
    const { rows, stats } = aggregateLines(['garbage', '', null, REAL_BOT, '\u0000\u0001'], { ranges: ranges() });
    assert.equal(rows.length, 1);
    assert.equal(stats.unparseable, 2);
    assert.deepEqual(aggregateLines([], { ranges: ranges() }).rows, []);
    assert.deepEqual(aggregateLines([REAL_META, REAL_BOT], { ranges: ranges() }).rows, aggregateLines([REAL_BOT, REAL_META], { ranges: ranges() }).rows);
  });
  test('with no ranges at all every tracked visit is "unchecked": a failed list fetch never marks real crawlers as fake', () => {
    const { rows } = aggregateLines([REAL_BOT], { ranges: compileRanges({}) });
    assert.equal(rows[0].verification, 'unchecked');
  });
  test('accepts any iterable (a file stream line by line, not just an array)', () => {
    function* gen() { yield REAL_BOT; yield REAL_META; }
    assert.equal(aggregateLines(gen(), { ranges: ranges() }).rows.length, 2);
  });
});

describe('applyDailyPathCap (the cap across uploads)', () => {
  const row = (path, hits = 1, day = '2026-11-17') => ({ day, botId: 'gptbot', path, status: 200, verification: 'verified', hits });
  test('new paths fill the room left after what is already stored; the rest fold into (other) and merge', () => {
    const existing = new Map([['2026-11-17', new Set(['/a', '/b'])]]);
    const out = applyDailyPathCap([row('/c'), row('/d', 2), row('/e', 3)], existing, 3);
    assert.deepEqual(out.map((r) => [r.path, r.hits]), [['/c', 1], [OTHER_PATH, 5]]);
  });
  test('a path that is already stored keeps its own row even when the day is full', () => {
    const out = applyDailyPathCap([row('/a', 4)], new Map([['2026-11-17', new Set(['/a', '/b', '/c'])]]), 3);
    assert.deepEqual(out.map((r) => [r.path, r.hits]), [['/a', 4]]);
  });
  test('"(other)" already stored does not use up a slot, and totals never change', () => {
    const existing = new Map([['2026-11-17', new Set(['/a', '/b', OTHER_PATH])]]);
    const rows = [row('/c', 2), row('/d', 5)];
    const out = applyDailyPathCap(rows, existing, 3);
    assert.deepEqual(out.map((r) => r.path), ['/c', OTHER_PATH]);
    assert.equal(out.reduce((n, r) => n + r.hits, 0), 7);
  });
  test('each day has its own room', () => {
    const out = applyDailyPathCap([row('/x', 1, '2026-11-17'), row('/x', 1, '2026-11-18'), row('/y', 1, '2026-11-18')], new Map(), 1);
    assert.deepEqual(out.map((r) => [r.day, r.path]), [['2026-11-17', '/x'], ['2026-11-18', '/x'], ['2026-11-18', OTHER_PATH]]);
  });
  test('no existing data at all is fine', () => {
    assert.deepEqual(applyDailyPathCap([row('/a')], undefined, 5).map((r) => r.path), ['/a']);
    assert.deepEqual(applyDailyPathCap([], new Map(), 5), []);
  });
});

// ── summarize (dashboard numbers) ──
import { summarize, normalizePath, periodBounds } from './summarize.js';
describe('summarize', () => {
  const today = new Date('2026-11-18T10:00:00Z');
  const row = (day, botId, path, status, verification, hits) => ({ day, botId, path, status, verification, hits });
  const rows = [
    row('2026-11-17', 'gptbot', '/', 200, 'verified', 5),
    row('2026-11-17', 'gptbot', '/pricing', 404, 'verified', 2),
    row('2026-11-16', 'applebot', '/blog/a/', 200, 'verified', 3),
    row('2026-11-16', 'claudebot', '/', 200, 'unverified', 4),
    row('2026-11-16', 'meta-externalagent', '/', 200, 'unchecked', 6),
    row('2026-11-16', 'googlebot', '/', 200, 'verified', 900),
    row('2026-10-05', 'gptbot', '/', 200, 'verified', 5), // previous period (28 days back from 17 Oct)
    row('2026-09-01', 'gptbot', '/', 200, 'verified', 99), // outside both
  ];
  const s = summarize(rows, { days: 28, today, inventory: ['/', '/pricing', '/blog/a', '/about'] });
  test('counts verified AI visits only, never Googlebot, unverified or unchecked', () => {
    assert.equal(s.totals.visits, 10);
    assert.equal(s.totals.unverified, 4);
    assert.equal(s.totals.unchecked, 6);
    assert.equal(s.totals.googlebotVisits, 900);
  });
  test('compares with the previous period of the same length', () => { assert.equal(s.totals.prevVisits, 5); assert.equal(s.totals.change, 100); });
  test('pages reached ignores error pages; pages not read lists the rest', () => {
    assert.equal(s.totals.pagesReached, 2);
    assert.deepEqual(s.pagesNotRead.items.sort(), ['/about', '/pricing']);
  });
  test('lists AI crawlers before Googlebot and zero-fills the daily series', () => {
    assert.equal(s.crawlers.at(-1).id, 'googlebot');
    assert.equal(s.daily.length, 28);
    assert.equal(s.daily.find((d) => d.day === '2026-11-17').byVendor.OpenAI, 7);
    assert.equal(s.daily.find((d) => d.day === '2026-11-15').total, 0);
  });
  test('normalises paths and period bounds', () => {
    assert.equal(normalizePath('https://x.com/a/b/?q=1'), '/a/b');
    assert.equal(normalizePath(''), '/');
    assert.equal(periodBounds(7, today).from, '2026-11-12');
  });
});
