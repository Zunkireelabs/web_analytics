import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Catches the exact class of bug fixed on this branch: a new opt-in feature
// flag (the "dedicated flag, never reuse an existing key's presence" pattern
// — see create.md §A.4) gets added in code and documented in .env.example,
// but nobody remembers to also add it to every deploy workflow's env block,
// so the feature silently 400s/no-ops on whichever environment was missed
// (ENABLE_CONTENT_CITATION_SEARCH was live in code + .env.example + CSE
// secrets on staging, but absent from deploy-staging.yml's heredoc — see
// commit 737d02c).
//
//   node server/scripts/check-env-parity.js
//
// Ground truth is the code itself (`process.env.FOO`), not .env.example —
// .env.example can be just as easily forgotten as a workflow file, so this
// walks server/ and mcp-server/ directly rather than trusting the doc.

const FLAG_PATTERN = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_ENABLED|ENABLE_[A-Z0-9_]+)$/;
const ENV_REF = /process\.env\.([A-Z][A-Z0-9_]*)/g;

// A flag being "on" in an environment isn't enough — the citation-search bug
// this script exists to catch has a sibling failure mode: the flag present
// AND the credential(s) it depends on missing in that SAME environment (the
// feature 400s at runtime instead of never turning on at all — arguably
// worse, since it looks configured until someone actually triggers it).
// generators/expand-content.js's own comment documents this exact pairing
// for citation search; add an entry here whenever a new opt-in flag depends
// on specific credential env vars, instead of learning about the gap from a
// user-facing failure again.
// Each flag maps to a list of ALTERNATIVE credential sets, not one flat
// list. search-grounding (ingest/search-grounding-providers/index.js) has a
// single provider now — Tavily, deliberately never serpapi/google-cse (those
// stay reserved for competitor-providers/'s real SERP data) — so citation
// search is satisfied by TAVILY_API_KEY alone.
const REQUIRED_CREDENTIALS = {
  ENABLE_CONTENT_CITATION_SEARCH: [['TAVILY_API_KEY']],
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function findCodeFlags() {
  const flags = new Map(); // name -> [file, ...]
  for (const dir of ['server', 'mcp-server']) {
    let files;
    try { files = walk(dir); } catch { continue; }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(ENV_REF)) {
        const name = m[1];
        if (FLAG_PATTERN.test(name)) {
          if (!flags.has(name)) flags.set(name, []);
          flags.get(name).push(file);
        }
      }
    }
  }
  return flags;
}

function assignedNamesIn(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function main() {
  const codeFlags = findCodeFlags();
  const envExampleNames = assignedNamesIn(readOptional('.env.example').replace(/^#\s*/gm, ''));
  const workflows = {
    'deploy-staging.yml': assignedNamesIn(readOptional('.github/workflows/deploy-staging.yml')),
    'deploy.yml': assignedNamesIn(readOptional('.github/workflows/deploy.yml')),
  };

  if (!codeFlags.size) {
    console.log('No *_ENABLED / ENABLE_* flags found referenced in server/ or mcp-server/.');
    return;
  }

  console.log('Opt-in flag parity check (code is ground truth, not .env.example):\n');
  const invisible = [];
  const rows = [];

  for (const [name, files] of [...codeFlags.entries()].sort()) {
    const inExample = envExampleNames.has(name);
    const inStaging = workflows['deploy-staging.yml'].has(name);
    const inProd = workflows['deploy.yml'].has(name);
    rows.push({ name, inExample, inStaging, inProd, files });
    if (!inExample && !inStaging && !inProd) invisible.push({ name, files });
  }

  const col = (b) => (b ? 'yes' : '-- ');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(36)} .env.example:${col(r.inExample)}  staging:${col(r.inStaging)}  prod:${col(r.inProd)}`);
  }

  const staggered = rows.filter((r) => r.inStaging !== r.inProd);
  if (staggered.length) {
    console.log('\nFlags that differ between staging and prod (may be an intentional staged rollout — confirm, don\'t auto-fix):');
    for (const r of staggered) console.log(`  ${r.name}: staging=${r.inStaging} prod=${r.inProd}`);
  }

  // Paired-credential check: for every flag that's actually assigned in a
  // given workflow, its required credential env vars must be assigned in
  // that SAME workflow — a flag "on" with its credential missing is the
  // silent-400-at-runtime failure mode, not the "never turns on" one above.
  const missingCredentials = [];
  for (const [flagName, alternativeSets] of Object.entries(REQUIRED_CREDENTIALS)) {
    for (const [workflowFile, names] of Object.entries(workflows)) {
      if (!names.has(flagName)) continue; // flag not even set here — nothing to pair-check
      const satisfied = alternativeSets.some((set) => set.every((v) => names.has(v)));
      if (satisfied) continue;
      // Report what's missing from EVERY alternative, so a dev sees a
      // complete path to satisfy either one, not just the first.
      const missingPerSet = alternativeSets.map((set) => set.filter((v) => !names.has(v)));
      missingCredentials.push({ flagName, workflowFile, missingPerSet });
    }
  }

  if (missingCredentials.length) {
    console.log('\nFAIL — flag is set ON in a workflow, but none of its alternative credential set(s) are fully present in that SAME workflow (silently 400s at runtime, looks configured until someone actually triggers it):');
    for (const { flagName, workflowFile, missingPerSet } of missingCredentials) {
      const alternatives = missingPerSet.map((missing) => `[${missing.join(', ')}]`).join(' OR ');
      console.log(`  ${flagName} is set in ${workflowFile}, but needs one full set from: ${alternatives}`);
    }
  }

  if (invisible.length || missingCredentials.length) {
    if (invisible.length) {
      console.log('\nFAIL — flag(s) read in code but present in NEITHER .env.example NOR any deploy workflow (the feature can never turn on anywhere):');
      for (const { name, files } of invisible) {
        console.log(`  ${name} — referenced in ${[...new Set(files)].join(', ')}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nOK — every opt-in flag found in code is set in at least one place, and every flag with required credentials has them alongside it.');
}

main();
