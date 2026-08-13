import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { getFileContent, getRepoTree, createBranch, commitFilesAtomic, openPullRequest, listOpenPullRequestsForBranch, defaultBranchName, getBranchSha } from '../github/client.js';
import { checkoutRepoTarball } from '../design-agent/repo-checkout.js';
import { sitePageUrl, classExistsInCss } from '../implementers/lib/design-drift.js';
import { detectMissingTypographyPlugin, computeTypographyRepairEdits } from '../agents/lib/prerequisite-repair.js';

const execFileAsync = promisify(execFile);

// THE §20/§9 ACCEPTANCE TEST — end to end, against the real Zunkiree Labs
// repo: detect a real missing-prerequisite defect, determine the safe repair
// from the repository itself, apply it in a CONTAINER build to prove it
// actually works before proposing anything, then open a real PR and STOP —
// no auto-merge, matching every other autonomous path in this app.
//
//   detect (live evidence: real templates + real shipped CSS)
//     -> compute the exact edits (prerequisite-repair.js)
//     -> checkout the real repo tarball into a scratch dir
//     -> apply the edits there
//     -> npm install && npm run build, for real
//     -> prove .prose now ships in the built CSS
//     -> render the affected pages and confirm they use it
//     -> commit to a new branch on the REAL repo, open a PR
//     -> stop for human review
//
// Run: node server/scripts/repair-missing-tailwind-typography.js --site-id <id>
//   [--install-command "npm ci"] [--build-command "npm run build"] [--output-dir "dist"]
// (same flags as install-rendering-workflow.js, for a site with no
// url_file_map.renderCapabilities.build stored yet)

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

async function walkCss(dir, files = []) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await walkCss(full, files);
    else if (entry.endsWith('.css')) files.push(full);
  }
  return files;
}

async function run() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) throw new Error('Usage: repair-missing-tailwind-typography.js --site-id <id> [--install-command ...] [--build-command ...] [--output-dir ...]');

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);
  if (!site.repo_owner || !site.repo_name) throw new Error(`Site #${siteId} has no repo configured — run npm run connect-repo first.`);

  const build = site.url_file_map?.renderCapabilities?.build || {};
  const installCommand = flags['install-command'] || build.installCommand;
  const buildCommand = flags['build-command'] || build.buildCommand;
  const outputDir = flags['output-dir'] || build.outputDir;
  if (!installCommand || !buildCommand || !outputDir) {
    throw new Error('Missing install/build command or output dir — pass --install-command/--build-command/--output-dir.');
  }

  // ── 1. DETECT, against real live evidence ──────────────────────────────
  console.log(`[1/6] Detecting a missing Tailwind Typography plugin on site #${siteId}...`);
  const detection = await detectMissingTypographyPlugin(site, {
    fetchTailwindConfig: async (p) => (await getFileContent(site, p, defaultBranchName(site)))?.content || null,
    fetchTree: async () => getRepoTree(site, defaultBranchName(site)),
    fetchFile: async (p) => (await getFileContent(site, p, defaultBranchName(site)))?.content || null,
    fetchPage: async (url) => (await fetch(url)).text(),
    fetchStylesheet: async (url) => (await fetch(url)).text(),
    pageUrl: sitePageUrl(site),
  });
  if (!detection) {
    console.log('No missing-typography defect detected — nothing to repair.');
    return;
  }
  if (detection.reason !== 'confirmed') {
    console.log(`Detection inconclusive (${detection.reason}) — refusing to propose a repair without live confirmation.`);
    return;
  }
  console.log(`  Confirmed: ${detection.usingProse.length} template(s) reference prose classes, live CSS ships none.`);
  for (const f of detection.usingProse) console.log(`    - ${f}`);

  // ── 2. COMPUTE the exact edits ──────────────────────────────────────────
  console.log('[2/6] Computing the exact repair...');
  const [pkgJson, twConfig] = await Promise.all([
    getFileContent(site, 'package.json', defaultBranchName(site)),
    getFileContent(site, 'tailwind.config.js', defaultBranchName(site)),
  ]);
  const edits = computeTypographyRepairEdits({ packageJsonSource: pkgJson.content, tailwindConfigSource: twConfig.content });
  if (!edits.ok) throw new Error(`Could not compute a safe repair: ${edits.reason}`);
  console.log(`  ${edits.edits.map((e) => e.path).join(', ')}`);

  // ── 3. VERIFY in a real container build, before proposing anything ─────
  console.log('[3/6] Checking out the real repo and building with the repair applied...');
  const scratchDir = await mkdtemp(join(tmpdir(), 'typography-repair-'));
  try {
    await checkoutRepoTarball(site, scratchDir);
    for (const edit of edits.edits) {
      await writeFile(join(scratchDir, edit.path), edit.content);
    }
    // `npm install`, not the site's configured installCommand (typically
    // `npm ci`), and deliberately so: this repair just added a new
    // devDependency to package.json, and `npm ci` refuses to run unless
    // package-lock.json already matches package.json exactly — it errors on
    // a lockfile that is honestly out of date rather than updating it, which
    // is correct for CI but wrong for the one commit that is introducing the
    // change in the first place. `npm install` is what a human contributor
    // would actually run here, and its job is exactly what's needed: update
    // the lockfile to match, so the resulting package-lock.json can be
    // committed alongside package.json and tailwind.config.js — after which
    // the site's own CI (`npm ci`) works normally on every subsequent PR.
    console.log('  Installing dependencies (npm install — regenerating the lockfile for the new dependency)...');
    await execFileAsync('sh', ['-c', 'npm install'], { cwd: scratchDir, maxBuffer: 64 * 1024 * 1024 });
    const lockfilePath = join(scratchDir, 'package-lock.json');
    edits.edits.push({ path: 'package-lock.json', content: await readFile(lockfilePath, 'utf8') });

    console.log(`  Building: ${buildCommand}`);
    await execFileAsync('sh', ['-c', buildCommand], { cwd: scratchDir, maxBuffer: 64 * 1024 * 1024 });

    console.log('[4/6] Verifying .prose now ships in the real built CSS...');
    const builtOutputDir = join(scratchDir, outputDir);
    const cssFiles = await walkCss(builtOutputDir);
    if (!cssFiles.length) throw new Error(`No built CSS found under ${outputDir} — the build may not have produced the expected output.`);
    let proseShips = false;
    for (const f of cssFiles) {
      const css = await readFile(f, 'utf8');
      if (classExistsInCss('prose', css)) { proseShips = true; break; }
    }
    if (!proseShips) throw new Error('Built the site with the repair applied, but .prose still does not appear in the shipped CSS — refusing to propose a PR that does not actually fix the defect.');
    console.log('  Confirmed: .prose now ships in the built CSS.');

    console.log('[5/6] Rendering the affected pages to confirm the prose wrapper actually applies...');
    // Eleventy layouts under _includes aren't pages of their own, so this
    // checks the built OUTPUT rather than tracing which specific URL(s) each
    // layout serves: confirm at least one real built page carries a
    // `class="...prose..."` attribute now backed by real CSS rules, proving
    // the wrapper is both PRESENT in markup and DEFINED in CSS — not just one
    // or the other.
    async function walkHtml(dir, files = []) {
      for (const entry of await readdir(dir)) {
        const full = join(dir, entry);
        const s = await stat(full);
        if (s.isDirectory()) await walkHtml(full, files);
        else if (entry.endsWith('.html')) files.push(full);
      }
      return files;
    }
    const htmlFiles = await walkHtml(builtOutputDir);
    let sampleWithProse = null;
    for (const f of htmlFiles) {
      const html = await readFile(f, 'utf8');
      if (/class="[^"]*\bprose\b[^"]*"/.test(html)) { sampleWithProse = f; break; }
    }
    if (!sampleWithProse) throw new Error('Rebuilt with the repair, and .prose ships in CSS, but no built page actually uses a prose class in its markup — refusing to propose a mismatched repair.');
    console.log(`  Confirmed: ${sampleWithProse.slice(builtOutputDir.length)} renders with a prose-wrapped class, now backed by real CSS.`);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  // ── 6. OPEN THE PR, and stop ─────────────────────────────────────────────
  console.log('[6/6] Opening a PR for human review — never auto-merging.');
  const branchName = 'action-center/repair-missing-tailwind-typography';
  const baseBranch = defaultBranchName(site);
  const baseSha = await getBranchSha(site, baseBranch);
  await createBranch(site, branchName, baseSha);
  await commitFilesAtomic(site, branchName, edits.edits, 'Install @tailwindcss/typography — prose classes ship with zero rules today');

  const existing = await listOpenPullRequestsForBranch(site, branchName);
  if (existing.length > 0) {
    console.log(`Existing PR updated: ${existing[0].html_url}`);
    return;
  }
  const { url } = await openPullRequest(site, {
    branch: branchName,
    title: 'Fix: install @tailwindcss/typography — prose classes render with zero effect today',
    body: [
      '**Detected automatically, verified by a real build before this PR was opened.**',
      '',
      `${detection.usingProse.length} template(s) use \`prose\`/\`prose-*\` classes, but \`@tailwindcss/typography\` was never installed `
        + '(`tailwind.config.js`\'s `plugins: []`) — confirmed against the live shipped CSS, which contains zero `.prose*` rules:',
      ...detection.usingProse.map((f) => `- \`${f}\``),
      '',
      'This means blog posts, glossary term pages, and location pages are all rendering body copy unstyled right now.',
      '',
      '**What changed:**',
      '- `package.json` — added `@tailwindcss/typography` as a devDependency',
      "- `tailwind.config.js` — imported the plugin and added it to `plugins: []`",
      '- `package-lock.json` — updated by a real `npm install` so this repo\'s own CI (`npm ci`) installs cleanly on the very next PR',
      '',
      '**Verified before opening this PR:** checked out this repo, applied every edit, ran `npm install && npm run build` for real, '
        + 'confirmed `.prose` now appears in the built CSS, and confirmed a real built page renders with a prose-wrapped class. '
        + 'No unrelated file was touched.',
      '',
      'Review the diff and merge when ready — this does not merge itself.',
    ].join('\n'),
  });
  console.log(`Opened PR: ${url}`);
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('repair-missing-tailwind-typography failed:', err.message);
    await pool.end();
    process.exit(1);
  });
