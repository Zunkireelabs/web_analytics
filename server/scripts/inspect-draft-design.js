// READ-ONLY inspection of ONE draft's design evidence: what the render gate
// measured, what markup the draft actually carries, and (optionally) a fresh
// re-render and diagnosis against the live reference page.
//
// Why this exists: the Direct Answer failure was diagnosed from the live site and
// from the code, never from the real draft. Until this has been run on the real
// draft, that diagnosis is NOT verified against it.
//
// It cannot change anything:
//   - the database part runs inside BEGIN READ ONLY ... ROLLBACK (Postgres itself
//     refuses any write), and issues one SELECT;
//   - --rerender only fetches the public reference page in a headless browser.
//
//   node server/scripts/inspect-draft-design.js --draft 1234
//   node server/scripts/inspect-draft-design.js --latest direct-answer [--site 7]
//   node server/scripts/inspect-draft-design.js --draft 1234 --rerender   # re-run the gate + diagnosis live
//   node server/scripts/inspect-draft-design.js --draft 1234 --html       # print the full rendered body
//   node server/scripts/inspect-draft-design.js --sql                     # print the SQL, touch nothing
//
// No database access from here? Run the SQL printed by --sql in any SQL console and
// send back the `render_gate` and `rendered_body` columns.
import { pathToFileURL } from 'node:url';
import { scanDraftHazards } from '../generators/lib/design-repair.js';

export const INSPECT_SQL = `SELECT id, site_id, action_type, status, finding_id, target_file_path,
       abandoned_reason, apply_error, render_gate, rendered_body
  FROM drafts
 WHERE action_type = 'direct-answer'
 ORDER BY created_at DESC
 LIMIT 5;
-- one draft: replace the WHERE with  id = <draft id>`;

const COLUMNS = 'id, site_id, action_type, status, finding_id, target_file_path, abandoned_reason, apply_error, render_gate, rendered_body';

// Pure. What the render gate recorded.
export function describeRenderGate(rg) {
  if (!rg || typeof rg !== 'object') return ['render_gate: none recorded (the gate did not block this draft, or has not run on it)'];
  const lines = [
    `render_gate.mode:          ${rg.mode ?? '?'}`,
    `render_gate.role:          ${rg.role?.role ?? '?'} (confidence ${rg.role?.confidence ?? '?'}, source ${rg.role?.source ?? '?'})`,
    `render_gate.reference:     ${rg.referenceUrl ?? '(none)'}`,
    `render_gate.verdict:       ${rg.reason ?? '?'}${rg.blocked ? ' — BLOCKED' : ''}`,
  ];
  const dev = rg.detail?.deviations || [];
  if (dev.length) {
    lines.push('render_gate.deviations:');
    for (const d of dev) lines.push(`   - ${d.kind}: the site renders ${d.expected}, the draft ${d.actual} (${d.viewport})`);
  }
  return lines;
}

// Pure. What the draft's own markup carries — the question the diagnosis turns on:
// does it arrive inside a wrapper / with the site's classes, or as bare elements?
export function describeDraftMarkup(body) {
  const text = String(body ?? '');
  const html = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const count = (re) => (html.match(re) || []).length;
  const classes = new Map();
  for (const m of html.matchAll(/\sclass\s*=\s*"([^"]*)"/gi)) for (const t of m[1].split(/\s+/).filter(Boolean)) classes.set(t, (classes.get(t) || 0) + 1);
  const firstTag = (html.trim().match(/^<([a-z][a-z0-9-]*)([^>]*)>/i) || [])[1] || null;
  const firstTagClass = ((html.trim().match(/^<[a-z][a-z0-9-]*[^>]*\sclass\s*=\s*"([^"]*)"/i) || [])[1]) || null;
  return {
    length: html.length,
    startsWithWrapper: ['div', 'section', 'article', 'main'].includes(firstTag),
    firstElement: firstTag ? `<${firstTag}${firstTagClass ? ` class="${firstTagClass}"` : ''}>` : '(starts with text/markdown)',
    paragraphs: count(/<p[\s>]/gi), h1: count(/<h1[\s>]/gi), h2: count(/<h2[\s>]/gi), h3: count(/<h3[\s>]/gi),
    bareParagraphs: count(/<p>/gi),
    inlineStyles: count(/\sstyle\s*=/gi),
    markdownHeadings: count(/^#{1,6}\s/gm),
    classTokens: [...classes].sort((a, b) => b[1] - a[1]).slice(0, 15),
    hazards: scanDraftHazards(html).map((h) => h.detail),
  };
}

export function formatInspection(row, { showHtml = false } = {}) {
  const m = describeDraftMarkup(row.rendered_body);
  const out = [
    `draft ${row.id}  site ${row.site_id}  ${row.action_type}  status=${row.status}`,
    `target file:  ${row.target_file_path ?? '(none)'}`,
    `abandoned:    ${row.abandoned_reason ?? '(no)'}`,
    `apply error:  ${row.apply_error ?? '(no)'}`,
    '', ...describeRenderGate(row.render_gate), '',
    'draft markup:',
    `   first element:        ${m.firstElement}${m.startsWithWrapper ? '   <- arrives inside a wrapper' : '   <- NO wrapper element at the top'}`,
    `   <p> total / bare <p>: ${m.paragraphs} / ${m.bareParagraphs}   (bare = no class at all)`,
    `   h1 / h2 / h3:         ${m.h1} / ${m.h2} / ${m.h3}`,
    `   markdown headings:    ${m.markdownHeadings}   (unconverted "#" lines render as plain text)`,
    `   inline style attrs:   ${m.inlineStyles}`,
    `   class tokens used:    ${m.classTokens.length ? m.classTokens.map(([t, n]) => `${t}(${n})`).join(', ') : '(none — every element is bare)'}`,
    `   layout hazards:       ${m.hazards.length ? m.hazards.join(' | ') : 'none found'}`,
  ];
  if (showHtml) out.push('', '--- rendered_body ---', String(row.rendered_body ?? ''), '--- end ---');
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--sql')) { console.log(INSPECT_SQL); return; }

  await import('dotenv/config');
  const { pool } = await import('../db.js');
  const draftId = arg('--draft');
  const latest = arg('--latest');
  const siteId = arg('--site');
  if (!draftId && !latest) { console.error('Give --draft <id> or --latest <action-type>. Use --sql to print the query instead.'); process.exit(2); }

  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = draftId
      ? await client.query(`SELECT ${COLUMNS} FROM drafts WHERE id = $1`, [draftId])
      : await client.query(`SELECT ${COLUMNS} FROM drafts WHERE action_type = $1 AND ($2::int IS NULL OR site_id = $2::int) ORDER BY created_at DESC LIMIT 1`, [latest, siteId]);
    row = rows[0];
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
  if (!row) { console.error('No matching draft.'); process.exit(1); }
  console.log(formatInspection(row, { showHtml: args.includes('--html') }));

  if (args.includes('--rerender')) {
    const { renderableBody, checkNewPageRender } = await import('../generators/lib/newpage-render-gate.js');
    const { diagnoseDesignFailure } = await import('../generators/lib/design-repair.js');
    const referenceUrl = row.render_gate?.referenceUrl;
    const body = renderableBody(row.rendered_body, 'markdown');
    if (!referenceUrl || body.skip) { console.log(`\nre-render skipped: ${!referenceUrl ? 'no reference page recorded' : body.reason}`); return; }
    const result = await checkNewPageRender({ referenceUrl, newPageHtml: body.html });
    console.log(`\nLIVE RE-RENDER against ${referenceUrl}`);
    console.log(`   result: ${result.ok ? (result.broken ? 'DEVIATES' : 'matches the site') : `could not run (${result.reason})`}`);
    for (const d of result.deviations || []) console.log(`   - ${d.kind}: site ${d.expected}, draft ${d.actual} (${d.viewport})`);
    if (result.broken) {
      const d = await diagnoseDesignFailure({ failure: { reason: 'render-deviation', deviations: result.deviations, referenceUrl }, draftHtml: body.html });
      console.log(`\nDIAGNOSIS: ${d.summary}`);
      for (const e of d.evidence) console.log(`   - ${e}`);
    }
  }
  console.log('\nRead-only: nothing was changed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
