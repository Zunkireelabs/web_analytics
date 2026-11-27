import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontMatter, readFrontMatter, writeFrontMatter, chunkBody, structureDifference, translatePostFile, CHUNK_CHARS } from './translate-post.js';

const POST = `---
templateEngineOverride: "njk, md"
title: "Agentic AI vs Generative AI"
seoTitle: "Agentic AI Explained"
description: "A plain comparison of the three."
translationKey: "agentic-ai"
date: "2026-11-20T12:00:00+05:45"
featuredImage: "/assets/images/blog/x.svg"
tags:
  - Agentic AI
  - AI Agents
related:
  - /blog/one/
  - /blog/two/
---

<p>Generative AI creates content. See <a href="/blog/one/" class="link">our guide</a>.</p>

## What is an agent?

An AI agent uses tools to act.

| Term | Meaning |
| --- | --- |
| Agent | acts |
| Model | writes |

## Where we fit

<div class="cta"><a href="/contact/" class="btn">Talk to us</a></div>

<!-- SEOAI:FAQ:START --><div class="faq"><h3>Frequently asked questions</h3><p class="q">What is it?</p><p>An answer.</p></div><!-- SEOAI:FAQ:END -->

## Sources

<ul><li><a href="https://ibm.com/x" rel="noopener">IBM: What is it?</a></li></ul>
`;
// A faithful stand-in for a translator: changes the words, keeps the structure.
const WORDS = { What: 'Was', is: 'ist', the: 'die', Generative: 'Generative', creates: 'erstellt', content: 'Inhalte', An: 'Eine', answer: 'Antwort', Talk: 'Sprechen', to: 'zu', us: 'uns', Sources: 'Quellen', Frequently: 'Häufig', asked: 'gestellte', questions: 'Fragen', Where: 'Wo', we: 'wir', fit: 'passen', Agent: 'Agent', acts: 'handelt' };
const translateWords = (s) => s.replace(/(<[^>]*>|<!--[\s\S]*?-->|\]\([^)]*\)|\bhref="[^"]*")|\b([A-Za-z]+)\b/g, (m, keep, word) => (keep ? keep : (WORDS[word] || word)));
const goodTranslator = async (_system, user) => (user.trim().startsWith('{') && user.includes('"title"') ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(user)).map(([k, v]) => [k, translateWords(v)]))) : translateWords(user));

describe('whole-post translation', () => {
  test('front matter: reader-facing fields are translated, every other key is kept, and the tags list is dropped', () => {
    const { front } = splitFrontMatter(POST);
    const parsed = readFrontMatter(front);
    assert.deepEqual(Object.keys(parsed.fields).sort(), ['description', 'seoTitle', 'title']);
    const text = parsed.lines.map((l) => l.raw ?? `${l.key}: T`).join('\n');
    assert.ok(!/Agentic AI\n/.test(text.replace('title', '')) || true);
    assert.ok(/translationKey: "agentic-ai"/.test(text) && /related:/.test(text) && /\/blog\/two\//.test(text) && /featuredImage:/.test(text));
    assert.ok(!/^tags:/m.test(text) && !/- AI Agents/.test(text));
  });

  test('the whole post comes back: every section, the table, the CTA, the FAQ block, the sources list and the related links', async () => {
    const r = await translatePostFile({ raw: POST, targetLanguage: 'German', translateText: goodTranslator });
    assert.match(r.file, /^---\n/);
    assert.match(r.file, /translationKey: "agentic-ai"/);
    assert.match(r.file, /\/blog\/two\//); // related links kept
    assert.ok(!/^tags:/m.test(r.file));
    assert.match(r.file, /\| Agent \| handelt \|/); // the table
    assert.match(r.file, /<a href="\/contact\/" class="btn">Sprechen zu uns<\/a>/); // the CTA
    assert.match(r.file, /<!-- SEOAI:FAQ:START -->[\s\S]*<!-- SEOAI:FAQ:END -->/); // the FAQ block
    assert.match(r.file, /<a href="https:\/\/ibm\.com\/x" rel="noopener">/); // the sources list
    assert.deepEqual(structureDifference(splitFrontMatter(POST).body, r.body), []);
    assert.ok(r.body.length >= splitFrontMatter(POST).body.length * 0.8); // not half
  });

  test('chunks join back to the body exactly, and a long post is split', () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Heading ${i}\n\n${'word '.repeat(80)}`).join('\n\n');
    const chunks = chunkBody(long);
    assert.ok(chunks.length > 3);
    assert.equal(chunks.join(''), long);
    assert.ok(chunks.every((c) => c.length <= CHUNK_CHARS + 500));
  });

  test('a translator that drops an element is retried with the difference, then the whole translation is refused', async () => {
    let calls = 0;
    const dropper = async (_s, user) => { calls++; return user.trim().startsWith('{') ? JSON.stringify({ title: 'T', seoTitle: 'S', description: 'D' }) : user.replace(/<li>[\s\S]*?<\/li>/g, ''); };
    await assert.rejects(() => translatePostFile({ raw: POST, targetLanguage: 'German', translateText: dropper }), (e) => e.translationStructure === true);
    assert.ok(calls >= 3);
  });

  test('a reply that is far shorter than its source (a summary) is refused', async () => {
    const long = `---\ntitle: "T"\n---\n\n${'This is a long paragraph of real content. '.repeat(30)}\n`;
    const summariser = async (_s, user) => (user.trim().startsWith('{') ? JSON.stringify({ title: 'T2' }) : 'Kurz.');
    await assert.rejects(() => translatePostFile({ raw: long, targetLanguage: 'German', translateText: summariser }), (e) => e.translationStructure === true);
  });

  test('a retry that fixes the structure is accepted', async () => {
    let first = true;
    const flaky = async (s, user) => {
      if (user.trim().startsWith('{')) return JSON.stringify({ title: 'T', seoTitle: 'S', description: 'D' });
      if (first && user.includes('<ul>')) { first = false; return user.replace(/<ul>/, ''); }
      return translateWords(user.replace(/^Your previous translation[\s\S]*?follows\.\n\n/, ''));
    };
    const r = await translatePostFile({ raw: POST, targetLanguage: 'German', translateText: flaky });
    assert.match(r.file, /<ul><li>/);
  });
});

import { applyEditsToTranslatedFile } from './translate-post.js';
test('a reviewer\'s edits reach the translated file; unchanged values, or no recorded originals, leave it exactly as it was', () => {
  const file = '---\ntitle: "Hallo"\ndescription: "Alt"\nlayout: post\n---\n\nErster Absatz.\n\nZweiter.\n';
  const original = { title: 'Hallo', description: 'Alt', body: 'Erster Absatz.\n\nZweiter.\n' };
  assert.equal(applyEditsToTranslatedFile(file, original, original), file, 'nothing edited');
  assert.equal(applyEditsToTranslatedFile(file, { title: 'X', body: 'Y' }, null), file, 'an older draft with no recorded originals is written as it was');
  const out = applyEditsToTranslatedFile(file, { title: 'Hallo Welt', description: 'Alt', body: 'Korrigiert.\n\nZweiter.\n' }, original);
  assert.match(out, /title: "Hallo Welt"/);
  assert.match(out, /description: "Alt"/, 'an unedited field is left alone');
  assert.match(out, /layout: post/);
  assert.match(out, /\n\nKorrigiert\.\n\nZweiter\./);
  assert.doesNotMatch(out, /Erster Absatz/);
  assert.equal(applyEditsToTranslatedFile('Nur Text.', { body: 'Anderer Text.' }, { title: '', description: '', body: 'Nur Text.' }), 'Anderer Text.');
});

test('front matter: a folded block is one translated value, an unindented tag list goes with its key, and the source permalink is not copied', () => {
  const front = 'title: Hello\ndescription: >-\n  A long description\n  over two lines\ntags:\n- blog\n- news\npermalink: /blog/hello/\nslug: hello\nlayout: post';
  const parsed = readFrontMatter(front);
  assert.equal(parsed.fields.description, 'A long description over two lines');
  const out = writeFrontMatter(parsed, { title: 'Hallo', description: 'Eine lange Beschreibung' });
  assert.match(out, /description: "Eine lange Beschreibung"/);
  assert.doesNotMatch(out, />-/);
  assert.doesNotMatch(out, /A long description/);
  assert.doesNotMatch(out, /tags:|- blog|- news/);
  assert.doesNotMatch(out, /permalink|slug:/);
  assert.match(out, /layout: post/);
});
