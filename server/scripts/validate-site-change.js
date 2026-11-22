import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBuilds, hasBuildOutput, collectPages } from '../implementers/lib/site-diff.js';

// Platform-wide "will this change break the website?" gate. Works on ANY client repo that builds to a folder of HTML (Next.js static
// export, Eleventy, Astro, Vite/React pre-render, plain static) — nothing here is framework- or client-specific; the build recipe
// comes from the caller (or the site's url_file_map.renderCapabilities.build). It builds the BASE ref and the CANDIDATE ref in two
// isolated temp folders (never inside the client's working copy), compares the two outputs (implementers/lib/site-diff.js) and,
// optionally, screenshots the pages that were meant to change plus a sample that were not, at desktop / tablet / mobile widths.
// Exit code 0 = safe to continue, 1 = a violation (do not ship), 2 = could not validate (also do not ship). Read-only with respect
// to the repo, the database and GitHub.
//
//   node server/scripts/validate-site-change.js --repo-dir ~/Projects/<repo> --base-ref origin/main --cand-ref <branch|sha> \
//     --origin https://example.com --install "npm ci --legacy-peer-deps" --build "npm run build" --output-dir out \
//     [--new /slug,/slug2] [--intended /page] [--removed /old] [--env KEY=VAL ...] [--screenshots] [--keep]

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const flags = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const has = (n) => argv.includes(`--${n}`);
const list = (n) => (flag(n) || '').split(',').map((s) => s.trim()).filter(Boolean);

function need(n) { const v = flag(n); if (!v) { console.error(`missing --${n}`); process.exit(2); } return v; }
const split = (cmd) => cmd.match(/(?:[^\s"]+|"[^"]*")+/g).map((t) => t.replace(/^"|"$/g, ''));

function exportRef(repoDir, ref, dest) {
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repoDir, ref, dest], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`could not export ${ref}: ${tar.stderr}`);
}

function run(cmd, cwd, env) {
  const [bin, ...args] = split(cmd);
  const r = spawnSync(bin, args, { cwd, env: { ...process.env, ...env, CI: '1' }, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function screenshots(dir, urls, outDir, label) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { skipped: 'playwright not installed' }; }
  const http = await import('node:http'); const fs = await import('node:fs'); const path = await import('node:path');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(dir, p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = fs.existsSync(path.join(f, 'index.html')) ? path.join(f, 'index.html') : `${f}.html`;
    if (!fs.existsSync(f) && fs.existsSync(`${f}.html`)) f = `${f}.html`;
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  let browser;
  try { browser = await chromium.launch(); } catch (e) { server.close(); return { skipped: `browser unavailable: ${String(e.message).split('\n')[0]}` }; }
  const sizes = { desktop: [1440, 900], tablet: [820, 1180], mobile: [390, 844] };
  const shots = [];
  for (const [name, [width, height]] of Object.entries(sizes)) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const failed = [];
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(`http://localhost:${port}`, '')}`); });
    for (const u of urls) {
      await page.goto(`http://localhost:${port}${u}`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => false);
      const file = join(outDir, `${label}-${name}-${u.replace(/\W+/g, '_') || 'home'}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      shots.push({ url: u, viewport: name, file, horizontalOverflow: overflow, failedRequests: [...new Set(failed.splice(0))] });
    }
    await ctx.close();
  }
  await browser.close(); server.close();
  return { shots };
}

// Compare two ALREADY-BUILT output folders (e.g. to re-check without rebuilding): --base-out DIR --cand-out DIR --origin URL [--new ...]
async function prebuilt() {
  const origin = need('origin');
  const cmp = compareBuilds({ baseDir: flag('base-out'), candDir: flag('cand-out'), origin, intendedUrls: list('intended'), newUrls: list('new'), removedUrls: list('removed') });
  let screens = null;
  if (has('screenshots')) {
    const shotDir = join(tmpdir(), `validate-shots-${Date.now()}`); mkdirSync(shotDir, { recursive: true });
    const pages = collectPages(flag('cand-out')).pages;
    const sample = [...new Set([...list('new'), ...list('intended'), '/', ...[...pages.keys()].filter((u) => u.split('/').length === 2).slice(0, 3)])].filter((u) => pages.has(u));
    screens = await screenshots(flag('cand-out'), sample, shotDir, 'cand');
    for (const s of screens.shots || []) {
      if (s.horizontalOverflow) cmp.violations.push({ code: 'horizontal-overflow', url: s.url, detail: s.viewport });
      for (const f of s.failedRequests) cmp.violations.push({ code: 'failed-request', url: s.url, detail: `${s.viewport}: ${f}` });
    }
    cmp.ok = cmp.violations.every((v) => v.severity === 'info');
  }
  console.log(JSON.stringify({ ok: cmp.ok, stats: cmp.stats, blocking: cmp.violations.filter((v) => v.severity !== 'info'), rippleCount: cmp.violations.filter((v) => v.severity === 'info').length, screenshots: screens?.skipped || screens?.shots?.map((s) => `${s.viewport}:${s.url}:overflow=${s.horizontalOverflow}`) }, null, 2));
  process.exitCode = cmp.ok ? 0 : 1;
}

async function main() {
  if (flag('base-out') && flag('cand-out')) return prebuilt();
  const repoDir = need('repo-dir'); const origin = need('origin');
  const baseRef = need('base-ref'); const candRef = need('cand-ref');
  const install = flag('install'); const build = need('build'); const outputDir = need('output-dir');
  const env = Object.fromEntries(flags('env').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const work = mkdtempSync(join(tmpdir(), 'validate-site-'));
  const result = { ok: false, work };
  try {
    const dirs = { base: join(work, 'base'), cand: join(work, 'cand') };
    for (const [k, ref] of [['base', baseRef], ['cand', candRef]]) {
      exportRef(repoDir, ref, dirs[k]);
      if (install) { const i = run(install, dirs[k], env); if (!i.ok) { console.error(`install failed (${k}):\n${i.out.slice(-1500)}`); process.exitCode = 2; return; } }
      const b = run(build, dirs[k], env);
      if (!b.ok) { console.error(`BUILD FAILED (${k} = ${ref}) — do not ship.\n${b.out.slice(-2500)}`); process.exitCode = k === 'cand' ? 1 : 2; return; }
      if (!hasBuildOutput(join(dirs[k], outputDir))) { console.error(`build of ${k} produced no HTML in "${outputDir}" — cannot validate; do not ship.`); process.exitCode = 2; return; }
    }
    const cmp = compareBuilds({ baseDir: join(dirs.base, outputDir), candDir: join(dirs.cand, outputDir), origin, intendedUrls: list('intended'), newUrls: list('new'), removedUrls: list('removed') });
    result.compare = cmp; result.ok = cmp.ok;
    if (has('screenshots')) {
      const shotDir = join(work, 'screenshots'); mkdirSync(shotDir, { recursive: true });
      const pages = collectPages(join(dirs.cand, outputDir)).pages;
      const sample = [...new Set([...list('new'), ...list('intended'), '/', ...[...pages.keys()].filter((u) => u.split('/').length === 2).slice(0, 3)])].filter((u) => pages.has(u));
      result.screenshots = await screenshots(join(dirs.cand, outputDir), sample, shotDir, 'cand');
      for (const s of result.screenshots.shots || []) {
        if (s.horizontalOverflow) cmp.violations.push({ code: 'horizontal-overflow', url: s.url, detail: s.viewport });
        for (const f of s.failedRequests) cmp.violations.push({ code: 'failed-request', url: s.url, detail: `${s.viewport}: ${f}` });
      }
      result.ok = cmp.violations.every((v) => v.severity === 'info'); cmp.ok = result.ok;
    }
    writeFileSync(join(work, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, stats: cmp.stats, violations: cmp.violations.slice(0, 50), violationCount: cmp.violations.length, screenshots: result.screenshots?.skipped || result.screenshots?.shots?.length, report: join(work, 'report.json') }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    if (!has('keep')) { try { rmSync(join(work, 'base'), { recursive: true, force: true }); rmSync(join(work, 'cand'), { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
