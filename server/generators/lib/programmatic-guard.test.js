import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findProgrammaticIssues, programmaticText, PROGRAMMATIC_GENERATOR_IDS } from './programmatic-guard.js';

// ~300-word landing page where only the city changes: the pattern the guard exists for.
const madLibs = (city) => ({
  target: city, headline: `Emergency plumbers in ${city}`, subheadline: `Fast reliable plumbing help across ${city} every day`,
  sections: Array.from({ length: 6 }, (_, i) => ({ heading: `Plumbing services in ${city} part ${i}`, body: [
    `Our team provides fast and reliable emergency plumbing services in ${city} every single day of the week.`,
    `Customers across ${city} trust us to fix leaking pipes blocked drains and broken water heaters on the first visit.`,
    `Call us today for a free quote on any plumbing job in ${city} and we will be there within the hour.`,
  ].join(' ') })),
  cta: `Call now in ${city}`,
});
// A landing page with its own facts, nothing shared with the template above.
const different = {
  target: 'Boiler replacement', headline: 'Replace an old boiler without the guesswork', subheadline: 'What a modern condensing unit saves, and what the fitting really involves',
  sections: [
    { heading: 'Why efficiency drops', body: 'Cast iron boilers older than fifteen years lose roughly a third of their fuel as hot flue gas while condensing models recover most of it through a second heat exchanger.' },
    { heading: 'What the fitting day looks like', body: 'An engineer drains the system, removes the old unit, flushes the pipework with a magnetic filter and then commissions the new boiler against the manufacturer checklist before handover.' },
    { heading: 'Costs that surprise people', body: 'Moving a flue, upgrading a gas pipe from fifteen to twenty two millimetres, and adding a smart thermostat each change the final quote by a different and predictable amount.' },
  ],
  cta: 'Book a survey',
};
const siblingsOf = (...contents) => async () => contents.map((content, i) => ({ id: i + 1, content }));

describe('findProgrammaticIssues', () => {
  test('a page that only swaps the city name fails the gate, with a correction telling the model what to do', async () => {
    const issues = await findProgrammaticIssues(madLibs('Boulder'), 'landing-page', 1, { listSiblings: siblingsOf(madLibs('Denver'), madLibs('Aurora')) });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'programmatic-template');
    assert.equal(issues[0].blocking, true);
    assert.match(issues[0].correction, /Boulder/);
    assert.match(issues[0].correction, /only \d+% of it is new/);
    assert.match(issues[0].correction, /Rewrite it/);
  });
  test('a genuinely different page passes', async () => {
    assert.deepEqual(await findProgrammaticIssues(different, 'landing-page', 1, { listSiblings: siblingsOf(madLibs('Denver'), madLibs('Aurora')) }), []);
  });
  test('the first page of a family has nothing to be a copy of', async () => {
    assert.deepEqual(await findProgrammaticIssues(madLibs('Denver'), 'landing-page', 1, { listSiblings: siblingsOf() }), []);
  });
  test('only landing pages are checked, and only with a site', async () => {
    const lib = { listSiblings: siblingsOf(madLibs('Denver')) };
    assert.deepEqual(await findProgrammaticIssues(madLibs('Boulder'), 'blog-outline', 1, lib), []);
    assert.deepEqual(await findProgrammaticIssues(madLibs('Boulder'), 'landing-page', null, lib), []);
    assert.deepEqual([...PROGRAMMATIC_GENERATOR_IDS], ['landing-page']);
  });
  test('siblings are looked up for THIS site and generator, excluding a draft of the same target', async () => {
    let args;
    await findProgrammaticIssues(madLibs('Boulder'), 'landing-page', 42, { listSiblings: async (...a) => { args = a; return []; } });
    assert.deepEqual(args, [42, 'landing-page', { excludeTarget: 'Boulder' }]);
  });
  test('an unreadable database skips the check instead of failing the draft', async () => {
    const issues = await findProgrammaticIssues(madLibs('Boulder'), 'landing-page', 1, { listSiblings: async () => { throw new Error('db down'); } });
    assert.deepEqual(issues, []);
  });
  test('empty content and siblings with no text are not an error', async () => {
    assert.deepEqual(await findProgrammaticIssues({}, 'landing-page', 1, { listSiblings: siblingsOf(madLibs('Denver')) }), []);
    assert.deepEqual(await findProgrammaticIssues(madLibs('Boulder'), 'landing-page', 1, { listSiblings: siblingsOf({}, null) }), []);
  });
});

test('programmaticText: what a visitor reads, not meta or images', () => {
  const t = programmaticText({ headline: 'H', subheadline: 'S', sections: [{ heading: 'a', body: 'b' }, null], cta: 'C', metaTitle: 'NO', metaDescription: 'NO', featuredImage: { url: 'NO' } });
  assert.equal(t, 'H\nS\na\nb\nC');
});
