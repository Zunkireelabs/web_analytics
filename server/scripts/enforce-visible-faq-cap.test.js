import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enforceVisibleFaqCap } from './enforce-visible-faq-cap.js';

const LD = '<script type="application/ld+json">{"@type":"FAQPage"}</script>';
const page = (n) => `<!-- SEOAI:FAQ:START --><div>visible faq ${n}</div>${LD}<!-- SEOAI:FAQ:END -->`;

async function repoWithPages(count) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'faq-cap-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  for (let i = 1; i <= count; i += 1) await writeFile(path.join(dir, 'src', `p${i}.njk`), page(i));
  return dir;
}

test('over the cap, nothing is demoted while FAQ schema must match the visible FAQ', async () => {
  const saved = process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  delete process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  const dir = await repoWithPages(3);
  try {
    const r = await enforceVisibleFaqCap(dir, 1, '', { write: true });
    assert.equal(r.visibleFound, 3);
    assert.equal(r.demoted, 0);
    assert.equal(r.skipped, 'faq-schema-requires-visible');
    // The files are untouched: every page still shows its FAQ.
    for (let i = 1; i <= 3; i += 1) assert.match(await readFile(path.join(dir, 'src', `p${i}.njk`), 'utf8'), /visible faq/);
  } finally {
    if (saved !== undefined) process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('with FAQ_SCHEMA_REQUIRES_VISIBLE=false the earlier demotion still works', async () => {
  const saved = process.env.FAQ_SCHEMA_REQUIRES_VISIBLE;
  process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = 'false';
  const dir = await repoWithPages(3);
  try {
    const r = await enforceVisibleFaqCap(dir, 1, '', { write: true });
    assert.equal(r.demoted, 2);
    assert.equal(r.skipped, undefined);
  } finally {
    if (saved === undefined) delete process.env.FAQ_SCHEMA_REQUIRES_VISIBLE; else process.env.FAQ_SCHEMA_REQUIRES_VISIBLE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('at or under the cap nothing changes in either mode', async () => {
  const dir = await repoWithPages(2);
  try {
    const r = await enforceVisibleFaqCap(dir, 5, '', { write: true });
    assert.deepEqual([r.demoted, r.visibleFound], [0, 2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
