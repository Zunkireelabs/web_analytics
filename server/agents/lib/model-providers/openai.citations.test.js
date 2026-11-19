import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citationsFromResponse, textFromResponse } from './openai.js';
import { domainsFromUrls } from './citations.js';

// Shape from OpenAI's web search guide (Responses API, 2026-11): a web_search_call item whose action lists the sources
// consulted (only with include: ['web_search_call.action.sources']), then a message whose output_text parts carry
// url_citation annotations.
const response = {
  output_text: 'SuperRank and Ahrefs both track AI answers.',
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'ai visibility tools', sources: [
      { type: 'url', url: 'https://www.superrank.si/features' },
      { type: 'url', url: 'https://ahrefs.com/blog/ai' },
      { type: 'url', url: 'https://example.org/list' },
    ] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SuperRank and Ahrefs both track AI answers.', annotations: [
      { type: 'url_citation', start_index: 0, end_index: 9, url: 'https://www.superrank.si/features?utm_source=openai', title: 'SuperRank' },
      { type: 'url_citation', start_index: 14, end_index: 20, url: 'https://ahrefs.com/blog/ai', title: 'Ahrefs' },
      { type: 'url_citation', start_index: 14, end_index: 20, url: 'https://ahrefs.com/blog/ai', title: 'Ahrefs again' },
    ] }] },
  ],
};

test('citations come from url_citation annotations, sources from the web_search_call', () => {
  const { citedUrls, sourceUrls } = citationsFromResponse(response);
  assert.deepEqual(citedUrls, ['https://www.superrank.si/features?utm_source=openai', 'https://ahrefs.com/blog/ai']);
  assert.equal(sourceUrls.length, 3);
});

test('cited domains drop www and keep citation order', () => {
  assert.deepEqual(domainsFromUrls(citationsFromResponse(response).citedUrls), ['superrank.si', 'ahrefs.com']);
});

test('the answer text carries the cited URLs so the mention check sees our own domain', () => {
  const raw = textFromResponse(response);
  assert.match(raw, /Sources:\nhttps:\/\/www\.superrank\.si\/features/);
});

test('a memory-only or empty response has no citations', () => {
  assert.deepEqual(citationsFromResponse({ output_text: 'hi', output: [] }), { citedUrls: [], sourceUrls: [] });
  assert.deepEqual(citationsFromResponse(null), { citedUrls: [], sourceUrls: [] });
  assert.deepEqual(domainsFromUrls(['not a url', null]), []);
});
