import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, keyPhrase, bestPageFor, CHECK_WINDOW } from './ai-visibility-board.js';

const prompt = (id, text, extra = {}) => ({ id, prompt_text: text, source: 'top-query', ship_requested_at: null, ship_draft_id: null, ship_error: null, ...extra });
const run = (prompt_id, run_date, mentioned, extra = {}) => ({ prompt_id, provider: 'openai', mentioned, approximate_position: mentioned ? 2 : null, competitors_mentioned: [], run_date, ...extra });

describe('keyPhrase', () => {
  test('drops a leading question stem and ranking word', () => {
    assert.equal(keyPhrase('best SEO analytics tool for agencies'), 'seo analytics tool for agencies');
    assert.equal(keyPhrase('How to get recommended by ChatGPT?'), 'get recommended by chatgpt');
    assert.equal(keyPhrase('What is the best llms.txt generator'), 'llms txt generator');
  });
  test('a prompt too short to be a phrase yields nothing', () => {
    assert.equal(keyPhrase('best seo'), '');
  });
  test('caps the phrase at six words', () => {
    assert.equal(keyPhrase('automate seo fixes without a developer on every page today').split(' ').length, 6);
  });
});

describe('bestPageFor', () => {
  test('picks the page sharing the most words with the phrase', () => {
    assert.equal(bestPageFor('client seo reporting', ['https://x.com/features', 'https://x.com/reports/seo']), '/reports/seo');
  });
  test('no overlap means no page (shown as "new page")', () => {
    assert.equal(bestPageFor('llms txt generator', ['https://x.com/about']), null);
  });
});

describe('buildBoard', () => {
  test('a prompt named in its latest check is seen, with rank and hits across the window', () => {
    const b = buildBoard({
      prompts: [prompt(1, 'seo report tool')],
      runs: [run(1, '2026-10-20', true), run(1, '2026-09-20', false), run(1, '2026-08-20', true)],
    });
    assert.equal(b.seen.length, 1);
    assert.equal(b.missing.length, 0);
    assert.equal(b.seen[0].hits, 2);
    assert.equal(b.seen[0].checks, 3);
    assert.equal(b.seen[0].position, 2);
  });

  test('a prompt not named in its latest check is missing even if an older check named it', () => {
    const b = buildBoard({ prompts: [prompt(1, 'seo report tool')], runs: [run(1, '2026-10-20', false), run(1, '2026-09-20', true)] });
    assert.equal(b.missing.length, 1);
    assert.equal(b.missing[0].hits, 1);
  });

  test('a prompt never checked is in neither list', () => {
    const b = buildBoard({ prompts: [prompt(1, 'never probed prompt')], runs: [] });
    assert.deepEqual([b.seen.length, b.missing.length], [0, 0]);
  });

  test('only the last six distinct check dates count', () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(1, `2026-0${i + 1}-15`, i === 0)); // oldest-first inputs, newest run is Sept
    const b = buildBoard({ prompts: [prompt(1, 'seo report tool')], runs: runs.reverse() });
    assert.equal(b.missing[0].checks, CHECK_WINDOW);
  });

  test('two engines on one date: seen if any names you, rank is the best one, seenOn lists only the naming engines', () => {
    const b = buildBoard({
      prompts: [prompt(1, 'seo report tool')],
      runs: [run(1, '2026-10-20', true, { approximate_position: 4 }), run(1, '2026-10-20', true, { provider: 'perplexity', approximate_position: 1 }), run(1, '2026-10-20', false, { provider: 'anthropic' })],
    });
    assert.equal(b.seen[0].position, 1);
    assert.deepEqual(b.seen[0].seenOn.sort(), ['openai', 'perplexity']);
    assert.equal(b.seen[0].engines.length, 3);
  });

  test('competitors come from the latest check and a shipped prompt carries its state', () => {
    const b = buildBoard({
      prompts: [prompt(1, 'seo report tool', { ship_requested_at: '2026-10-21', ship_draft_id: 7 }), prompt(2, 'other seo tool', { ship_requested_at: '2026-10-21' })],
      runs: [run(1, '2026-10-20', false, { competitors_mentioned: ['Semrush'] }), run(2, '2026-10-20', false)],
    });
    const byId = Object.fromEntries(b.missing.map((m) => [m.id, m]));
    assert.deepEqual(byId[1].competitors, ['Semrush']);
    assert.equal(byId[1].ship, 'drafted');
    assert.equal(byId[2].ship, 'queued');
    assert.equal(b.missing[0].ship, null === byId[2].ship ? null : b.missing[0].ship); // unshipped sort first (none here), stable
  });

  test('words: one row per phrase with how many missing prompts it covers; suggestions skip tracked prompts', () => {
    const b = buildBoard({
      prompts: [prompt(1, 'best seo analytics tool'), prompt(2, 'seo analytics tool for agencies'), prompt(3, 'best seo analytics tool for agencies')],
      runs: [run(1, '2026-10-20', false), run(2, '2026-10-20', false), run(3, '2026-10-20', false)],
      pages: ['https://x.com/features'],
    });
    assert.equal(b.words.length, 2);
    assert.ok(b.words.every((w) => w.covers >= 1));
    assert.ok(!b.suggestions.includes('best seo analytics tool'), 'already-tracked prompt is not suggested again');
    assert.ok(b.suggestions.every((s) => s.startsWith('best ')));
  });
});
