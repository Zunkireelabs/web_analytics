// Local-only API for the demo page: the REAL preview and edit code (server/lib/draft-article-preview.js) on example drafts held in memory. It never writes to a database.
import fs from 'node:fs';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1):\d+\//.test(db)) { console.error('Refusing to start: DATABASE_URL must point at the LOCAL database (the quality gate reads it). See README.md.'); process.exit(1); }
const { previewDraftLive, editDraftBlock } = await import('../../server/lib/draft-article-preview.js');
const { runQualityGate } = await import('../../server/generators/lib/quality-gate.js');
const { buildClaudeArgs, parseClaudeOutput } = await import('../../tools/claude-code-worker/lib.mjs');

const FIX = JSON.parse(fs.readFileSync(process.env.FIXTURES, 'utf8'));
const sites = new Map(FIX.sites.map((s) => [s.id, { id: s.id, name: s.name, url_file_map: { siteRoot: { designProfile: { pages: s.pages } } } }]));
// The site's own FAQ design is learned from its other pages; here those page lists come from the example data, not a database.
const { learnSiteFaqTemplate } = await import('../../server/generators/lib/site-faq-learn.js');
for (const s of FIX.sites) await learnSiteFaqTemplate({ id: s.id }, { listPages: async () => s.inventory || [] });
const original = new Map(FIX.drafts.map((d) => [d.id, d]));
let drafts = new Map(FIX.drafts.map((d) => [d.id, structuredClone(d)]));
const AI = process.env.DEMO_AI === 'claude' ? 'claude' : 'off';

// The same plain-text call the Claude worker makes (no tools, no saved session), run once per request on THIS machine's Claude Code login. Only with DEMO_AI=claude.
function claudeJson(system, user) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-ai-')); const systemFile = join(dir, 'system.txt'); writeFileSync(systemFile, system);
    const child = spawn('claude', buildClaudeArgs({ systemFile, model: 'haiku' }), { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN')) }); // this machine's Claude Code login, never the (paid) API key
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code, signal) => {
      const parsed = parseClaudeOutput({ stdout: out, stderr: err, code, signal });
      if (!parsed.ok) return reject(Object.assign(new Error(`The writing assistant could not answer: ${parsed.error}`), { workerUnavailable: true }));
      const raw = String(parsed.text || '').replace(/^\s*```[a-z]*\n?/, '').replace(/\n?```\s*$/, '');
      try { resolve(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))); } catch { reject(Object.assign(new Error('The writing assistant did not return a usable answer.'), { status: 400 })); }
    });
    child.stdin.end(user);
  });
}
const offline = async () => { throw Object.assign(new Error('offline'), { workerUnavailable: true }); };

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/demo/index', (_req, res) => res.json({ ai: AI, drafts: [...drafts.values()].map((d) => ({ id: d.id, siteId: d.siteId, client: sites.get(d.siteId).name, title: d.content.title })) }));
app.post('/api/demo/reset', (_req, res) => { drafts = new Map(FIX.drafts.map((d) => [d.id, structuredClone(d)])); res.json({ ok: true }); });
app.get('/api/action-center/drafts/:id/live-preview', async (req, res, next) => {
  try {
    const d = drafts.get(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Draft not found' });
    const r = await previewDraftLive(sites.get(d.siteId), d);
    if (r.ok) return res.json(r);
    res.status(['not-an-article', 'no-reference-article'].includes(r.reason) ? 422 : 502).json({ error: r.error, reason: r.reason });
  } catch (e) { next(e); }
});
app.post('/api/action-center/drafts/:id/edit-block', async (req, res, next) => {
  try {
    const d = drafts.get(Number(req.params.id)); if (!d) return res.status(404).json({ error: 'Draft not found' });
    const site = sites.get(d.siteId);
    const r = await editDraftBlock(site, d, req.body || {}, {
      runGate: (content) => runQualityGate(content, d.action_type, d.siteId, { site, page: null, pageType: null, pageClassification: null }),
      save: async (content) => { d.content = content; return d; },
      callJson: AI === 'claude' ? (system, user) => claudeJson(system, user) : offline,
    });
    if (r.ok) return res.json(r);
    res.status(r.status || 400).json({ error: r.error, reason: r.reason, issues: r.issues });
  } catch (e) { next(e); }
});
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: String(err.message || err).slice(0, 200) }); });
app.listen(3099, () => console.log(`Demo API on :3099 (AI rewrites: ${AI}). Open http://localhost:5199`));
