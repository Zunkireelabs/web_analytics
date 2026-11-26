// Re-renders a project's abandoned blog articles with the CURRENT renderer and puts them through the unchanged rendering gate; the ones that pass go back to
// 'draft' (approvable), the rest stay abandoned and the new failure is printed. See lib/self-repair/rerender-blog-drafts.js.
// DRY-RUN BY DEFAULT: renders and checks, writes nothing. --apply restores the passing ones, after saving a backup of the rows OUTSIDE the repo
// (the OS temp folder; it holds client content, which must never be committed). One project per run.
//
//   node server/scripts/rerender-abandoned-blog-drafts.js --site 1            (report)
//   node server/scripts/rerender-abandoned-blog-drafts.js --site 1 --apply    (restore the ones that pass; needs the owner's OK: it writes production data)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rerenderAbandonedBlogDrafts } from '../lib/self-repair/rerender-blog-drafts.js';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const siteId = Number(arg('site'));
const apply = process.argv.includes('--apply');
if (!Number.isInteger(siteId) || siteId < 1) { console.error('usage: --site <id> [--apply]'); process.exit(2); }

const { getSiteById } = await import('../store/read.js');
const { resolveTargetAndBody } = await import('../implementers/frontend.js');
const { validateRendering } = await import('../implementers/lib/rendering-gate.js');
const db = await import('../db.js');
const backup = async (rows) => {
  const file = path.join(os.tmpdir(), `rerender-backup-site${siteId}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 1), { mode: 0o600 });
  console.log(`backup of ${rows.length} row(s): ${file} (outside the repo; do not commit it)`);
};
try {
  const r = await rerenderAbandonedBlogDrafts(siteId, { apply, getSite: getSiteById, resolveTargetAndBody, validateRendering, backup });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} site ${siteId}: ${r.candidates} abandoned, ${r.restorable} pass the gate, ${r.restored} restored, ${r.stillFailing} still fail.`);
  for (const i of r.items) console.log(` - draft ${i.draftId}: ${i.result}${i.detail ? ` (${i.detail})` : ''}`);
} finally { await db.pool?.end?.(); }
