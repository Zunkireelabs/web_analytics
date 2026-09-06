// Framework / build-system detection from repository evidence alone.
//
// Deliberately deterministic and evidence-first (Phase 2, §2/§8/§19): every
// verdict names the real files that produced it, so a reader can check the
// reasoning rather than trust a number. No LLM is involved at this layer —
// "does .eleventy.js exist, and is @11ty/eleventy in package.json" is a fact,
// not a judgement, and a fact that can be checked has no business being
// guessed. That also means this stays free, instant, and identical on every
// run, which the confidence model below depends on.
//
// The signal set is intentionally generic rather than one client's shape (the
// architectural principle in §19): a framework is recognised by the artifacts
// its own ecosystem creates — its config filename, its package name, its
// conventional directories — none of which are specific to any tenant. Adding
// a framework is one entry here, never a per-client branch anywhere else.

// Each signal is worth points; a framework's confidence comes from how many
// INDEPENDENT kinds of evidence agree, never from any single file. That's
// what stops a stray config file (a leftover .babelrc, a copied Dockerfile)
// from outvoting the actual dependency manifest.
//
// weight rationale:
//   dependency (5) — the strongest single signal: the project explicitly
//     declares it builds with this tool.
//   config file (4) — near-conclusive, but can be vestigial.
//   directory (2) — conventional, but conventions collide across frameworks
//     (src/pages exists in Next.js, Astro AND Eleventy setups).
const FRAMEWORKS = [
  {
    id: 'eleventy',
    name: 'Eleventy (11ty)',
    kind: 'static-site-generator',
    dependencies: ['@11ty/eleventy'],
    configFiles: ['.eleventy.js', 'eleventy.config.js', 'eleventy.config.mjs', '.eleventy.cjs'],
    directories: ['src/_includes', '_includes', 'src/_data', '_data'],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    kind: 'react-framework',
    dependencies: ['next'],
    configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    directories: ['pages', 'app', 'src/pages', 'src/app'],
  },
  {
    id: 'astro',
    name: 'Astro',
    kind: 'static-site-generator',
    dependencies: ['astro'],
    configFiles: ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'],
    directories: ['src/pages', 'src/layouts', 'src/components'],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    kind: 'vue-framework',
    dependencies: ['nuxt'],
    configFiles: ['nuxt.config.js', 'nuxt.config.ts'],
    directories: ['pages', 'layouts'],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    kind: 'svelte-framework',
    dependencies: ['@sveltejs/kit'],
    configFiles: ['svelte.config.js'],
    directories: ['src/routes'],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    kind: 'react-framework',
    dependencies: ['gatsby'],
    configFiles: ['gatsby-config.js', 'gatsby-config.ts'],
    directories: ['src/pages', 'src/templates'],
  },
  {
    id: 'hugo',
    name: 'Hugo',
    kind: 'static-site-generator',
    dependencies: [], // Go-based: no package.json to declare it
    configFiles: ['config.toml', 'hugo.toml', 'config.yaml', 'hugo.yaml'],
    directories: ['layouts', 'archetypes', 'content'],
  },
  {
    id: 'jekyll',
    name: 'Jekyll',
    kind: 'static-site-generator',
    dependencies: [],
    configFiles: ['_config.yml'],
    directories: ['_layouts', '_posts', '_includes'],
  },
  {
    id: 'vite-spa',
    name: 'Vite (SPA)',
    kind: 'bundler-spa',
    dependencies: ['vite'],
    configFiles: ['vite.config.js', 'vite.config.ts'],
    directories: ['src'],
  },
];

const PACKAGE_MANAGERS = [
  { id: 'pnpm', lockFile: 'pnpm-lock.yaml' },
  { id: 'yarn', lockFile: 'yarn.lock' },
  { id: 'bun', lockFile: 'bun.lockb' },
  { id: 'npm', lockFile: 'package-lock.json' },
];

const DEPLOYMENT_TARGETS = [
  { id: 'vercel', files: ['vercel.json', '.vercel/project.json'] },
  { id: 'netlify', files: ['netlify.toml', '_redirects'] },
  { id: 'cloudflare-pages', files: ['wrangler.toml', 'wrangler.json'] },
  { id: 'github-pages', files: ['.github/workflows/pages.yml', 'CNAME'] },
  { id: 'docker', files: ['Dockerfile', 'docker-compose.yml'] },
];

// A template language tells later stages what a "template file" even looks
// like for this repo — which is what makes route/page discovery generic
// instead of assuming one ecosystem's file extension.
const TEMPLATE_LANGUAGES = [
  { id: 'nunjucks', extensions: ['.njk'] },
  { id: 'liquid', extensions: ['.liquid'] },
  { id: 'handlebars', extensions: ['.hbs', '.handlebars'] },
  { id: 'ejs', extensions: ['.ejs'] },
  { id: 'pug', extensions: ['.pug'] },
  { id: 'markdown', extensions: ['.md', '.markdown'] },
  { id: 'jsx', extensions: ['.jsx', '.tsx'] },
  { id: 'vue', extensions: ['.vue'] },
  { id: 'svelte', extensions: ['.svelte'] },
  { id: 'astro', extensions: ['.astro'] },
  { id: 'html', extensions: ['.html', '.htm'] },
];

// Confidence is derived from the evidence score, never asserted. The bands
// exist so downstream autonomy decisions (§9) read a stable vocabulary
// instead of comparing raw numbers at each call site.
//
// A dependency + a config file (9) is treated as conclusive: those two agreeing
// is the same evidence a human engineer would accept without looking further.
export function confidenceFromScore(score) {
  if (score >= 9) return { level: 'high', value: 0.98 };
  if (score >= 6) return { level: 'high', value: 0.9 };
  if (score >= 4) return { level: 'medium', value: 0.7 };
  if (score >= 2) return { level: 'low', value: 0.4 };
  return { level: 'none', value: 0 };
}

function parsePackageJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// files: string[] of repo-relative paths (github/client.js's getRepoTree
// returns exactly this). packageJsonRaw: file contents or null — a repo
// without one (Hugo, Jekyll) is normal, not an error.
export function detectTechnology({ files = [], packageJsonRaw = null } = {}) {
  const fileSet = new Set(files);
  const pkg = parsePackageJson(packageJsonRaw);
  const declared = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  const candidates = [];
  for (const fw of FRAMEWORKS) {
    const evidence = [];
    let score = 0;

    for (const dep of fw.dependencies) {
      if (declared[dep]) {
        score += 5;
        evidence.push({ kind: 'dependency', detail: `package.json declares "${dep}" (${declared[dep]})`, source: 'package.json' });
      }
    }
    for (const cfg of fw.configFiles) {
      if (fileSet.has(cfg)) {
        score += 4;
        evidence.push({ kind: 'config-file', detail: `${cfg} present at repo root`, source: cfg });
      }
    }
    // Directories are counted ONCE regardless of how many match: five
    // conventional directories existing is not five independent proofs, and
    // treating it as such would let convention alone outweigh a real
    // dependency declaration.
    const dirHits = fw.directories.filter((d) => files.some((f) => f.startsWith(`${d}/`)));
    if (dirHits.length) {
      score += 2;
      evidence.push({ kind: 'directory', detail: `conventional director${dirHits.length === 1 ? 'y' : 'ies'} present: ${dirHits.join(', ')}`, source: dirHits[0] });
    }

    if (score > 0) candidates.push({ ...fw, score, evidence, confidence: confidenceFromScore(score) });
  }

  candidates.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = candidates;

  // Two frameworks scoring comparably is a genuine ambiguity, not something
  // to resolve by picking the higher one — a repo really can be mid-migration.
  // Surfacing it as unresolved (§11) is the honest outcome; silently choosing
  // would produce confident-looking mappings against the wrong ecosystem.
  const ambiguous = !!(best && runnerUp && best.score - runnerUp.score < 4);

  const packageManager = PACKAGE_MANAGERS.find((pm) => fileSet.has(pm.lockFile)) || null;
  const deployment = DEPLOYMENT_TARGETS.filter((t) => t.files.some((f) => fileSet.has(f)));

  const extCounts = new Map();
  for (const f of files) {
    const dot = f.lastIndexOf('.');
    if (dot > 0) {
      const ext = f.slice(dot);
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }
  }
  const templateLanguages = TEMPLATE_LANGUAGES
    .map((t) => ({ id: t.id, count: t.extensions.reduce((n, e) => n + (extCounts.get(e) || 0), 0), extensions: t.extensions }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    framework: best
      ? {
        id: best.id,
        name: best.name,
        kind: best.kind,
        confidence: ambiguous ? { level: 'medium', value: 0.6 } : best.confidence,
        evidence: best.evidence,
        // Never silently discarded — a later stage (or a human) can see what
        // else the repository looked like.
        alternatives: candidates.slice(1, 3).map((c) => ({ id: c.id, name: c.name, score: c.score })),
        ambiguous,
      }
      : null,
    packageManager: packageManager
      ? { id: packageManager.id, evidence: [{ kind: 'lock-file', detail: `${packageManager.lockFile} present`, source: packageManager.lockFile }] }
      : null,
    buildScripts: pkg?.scripts
      ? Object.fromEntries(Object.entries(pkg.scripts).filter(([k]) => ['build', 'start', 'dev', 'serve'].includes(k)))
      : null,
    deploymentTargets: deployment.map((d) => ({
      id: d.id,
      evidence: d.files.filter((f) => fileSet.has(f)).map((f) => ({ kind: 'config-file', detail: `${f} present`, source: f })),
    })),
    templateLanguages,
    fileCount: files.length,
  };
}

export const __testables = { FRAMEWORKS, TEMPLATE_LANGUAGES };
