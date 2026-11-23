import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { emptyProfile, normalizeProfile } from '../lib/business-profile.js';

// Writes the owner-confirmed company facts (docs/audits/2026-11-23-ai-visibility/confirmed-facts.json) into each project's canonical
// business profile, the one place every agent and generator already reads (lib/tenant-context.js). Only the `description` field is
// set, marked confirmed by a person; every other field of an existing profile is kept exactly as it is.
//
// DRY-RUN BY DEFAULT: it prints the plan and writes nothing unless --apply is passed. It appends a version (the table is
// append-only), so a mistake is undone by writing a corrected version, never by deleting history.
//
//   node server/scripts/apply-confirmed-facts.js                      all six projects, dry run
//   node server/scripts/apply-confirmed-facts.js --site 8864          one project, dry run
//   node server/scripts/apply-confirmed-facts.js --apply --actor <who confirmed it>
//
// Writing to the production database needs a person's explicit OK; --apply refuses to run without --actor.

export const FACTS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/audits/2026-11-23-ai-visibility/confirmed-facts.json');
export const ALLOWED_SITES = new Set([1, 8862, 8864, 8871, 8872, 8874]);

// The profile this project should have after the write: its current profile with only `description` replaced by the confirmed
// text. Pure, so it is testable without a database.
export function buildConfirmedProfile(current, description, { actor, now = new Date() } = {}) {
  const base = normalizeProfile(current || emptyProfile());
  base.fields.description = {
    value: description,
    status: 'confirmed',
    confidence: 'high',
    evidence: [{ source: 'human', ref: 'owner confirmation 2026-11-23', summary: 'Facts confirmed by the owner; they match what the client publishes.' }],
    verifiedAt: now.toISOString(),
    verifiedBy: actor ?? null,
  };
  return normalizeProfile(base);
}

export function loadFacts(file = FACTS_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const facts = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    const id = Number(k);
    if (!ALLOWED_SITES.has(id)) throw new Error(`site ${k} is not an allowed project`);
    if (!v?.description || typeof v.description !== 'string') throw new Error(`site ${k} has no description`);
    facts[id] = v;
  }
  return facts;
}

async function main() {
  const argv = process.argv;
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };
  const apply = flag('apply') === true;
  const actor = typeof flag('actor') === 'string' ? flag('actor') : null;
  const only = flag('site') ? Number(flag('site')) : null;
  if (apply && !actor) { console.error('--apply needs --actor <the person who confirmed these facts>'); process.exit(1); }

  const { getCurrentBusinessProfile, insertBusinessProfileVersion } = await import('../store/business-profile.js');
  const facts = loadFacts();
  for (const [id, f] of Object.entries(facts)) {
    const siteId = Number(id);
    if (only && only !== siteId) continue;
    const current = await getCurrentBusinessProfile(siteId);
    const next = buildConfirmedProfile(current?.profile, f.description, { actor });
    const had = current?.profile?.fields?.description?.value ?? null;
    console.log(`\n=== Site ${siteId} "${f.name}"  ${apply ? 'APPLY' : 'DRY RUN'}  (current version: ${current?.version ?? 'none'})`);
    console.log(`  description before: ${had ?? '(none)'}`);
    console.log(`  description after:  ${next.fields.description.value}`);
    if (!apply) continue;
    const r = await insertBusinessProfileVersion(siteId, { profile: next, changed: ['description'], source: 'human', actor, reason: 'import' });
    console.log(`  -> ${r.unchanged ? `unchanged (version ${r.version})` : r.skipped ? `skipped: ${r.skipped}` : `written as version ${r.version}`}`);
  }
  if (!apply) console.log('\nDry run: nothing was written. Re-run with --apply --actor <name> after the owner approves.');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
