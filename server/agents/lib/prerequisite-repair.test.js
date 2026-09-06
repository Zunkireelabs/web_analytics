import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMissingTypographyPlugin, addTypographyToPackageJson, addTypographyToTailwindConfig,
  computeTypographyRepairEdits,
} from './prerequisite-repair.js';

// Real shapes from zunkireelabs-web's actual default branch, fetched live
// while diagnosing this — the exact site and defect this repair exists for.
const REAL_TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{html,njk,md,js}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`;

const REAL_PACKAGE_JSON = JSON.stringify({
  name: 'zunkireelabs-web',
  scripts: { dev: 'eleventy --serve', build: 'eleventy' },
  dependencies: { '@11ty/eleventy': '^3.1.2' },
  devDependencies: { tailwindcss: '^3.4.17', autoprefixer: '^10.4.20' },
}, null, 2);

describe('addTypographyToTailwindConfig — a targeted, minimal edit', () => {
  test('adds the import and wires it into an empty plugins array — the real zunkireelabs-web shape', () => {
    const result = addTypographyToTailwindConfig(REAL_TAILWIND_CONFIG);
    assert.match(result, /^import typography from '@tailwindcss\/typography';/);
    assert.match(result, /plugins: \[typography\]/);
    assert.match(result, /content: \[\s*"\.\/src\/\*\*\/\*\.\{html,njk,md,js\}",/, 'the rest of the file must survive untouched');
  });

  test('preserves existing plugins rather than replacing them', () => {
    const config = "export default { plugins: [require('@tailwindcss/forms')] }";
    const result = addTypographyToTailwindConfig(config);
    assert.match(result, /plugins: \[require\('@tailwindcss\/forms'\), typography\]/);
  });

  test('is idempotent — already-configured is returned untouched', () => {
    const config = "import typography from '@tailwindcss/typography';\nexport default { plugins: [typography] }";
    assert.equal(addTypographyToTailwindConfig(config), config);
  });

  test('refuses rather than guesses when the plugins array cannot be found', () => {
    const config = 'export default {}'; // no `plugins:` key at all
    assert.equal(addTypographyToTailwindConfig(config), null);
  });

  test('does not duplicate the import line if one already exists for some other reason', () => {
    const config = "import typography from '@tailwindcss/typography';\nexport default { plugins: [] }";
    const result = addTypographyToTailwindConfig(config);
    assert.equal((result.match(/^import typography/gm) || []).length, 1);
  });
});

describe('addTypographyToPackageJson', () => {
  test('adds the dependency, preserving every other key', () => {
    const result = addTypographyToPackageJson(REAL_PACKAGE_JSON);
    const parsed = JSON.parse(result);
    assert.equal(parsed.devDependencies['@tailwindcss/typography'], '^0.5.20');
    assert.equal(parsed.devDependencies.tailwindcss, '^3.4.17', 'existing deps must survive');
    assert.equal(parsed.name, 'zunkireelabs-web');
    assert.deepEqual(parsed.scripts, { dev: 'eleventy --serve', build: 'eleventy' });
  });

  test('is idempotent — already present is returned byte-for-byte untouched', () => {
    const withIt = JSON.stringify({ devDependencies: { '@tailwindcss/typography': '^0.5.20' } }, null, 2);
    assert.equal(addTypographyToPackageJson(withIt), withIt);
  });

  test('checks dependencies as well as devDependencies before deciding it is missing', () => {
    const inDeps = JSON.stringify({ dependencies: { '@tailwindcss/typography': '^0.5.0' } }, null, 2);
    assert.equal(addTypographyToPackageJson(inDeps), inDeps);
  });

  test('creates devDependencies from scratch when the file has none at all', () => {
    const bare = JSON.stringify({ name: 'x' });
    const result = JSON.parse(addTypographyToPackageJson(bare));
    assert.equal(result.devDependencies['@tailwindcss/typography'], '^0.5.20');
  });
});

describe('computeTypographyRepairEdits', () => {
  test('returns both file edits together, ready to commit atomically', () => {
    const result = computeTypographyRepairEdits({ packageJsonSource: REAL_PACKAGE_JSON, tailwindConfigSource: REAL_TAILWIND_CONFIG });
    assert.equal(result.ok, true);
    assert.equal(result.edits.length, 2);
    assert.deepEqual(result.edits.map((e) => e.path).sort(), ['package.json', 'tailwind.config.js']);
  });

  test('refuses the whole repair, not a partial one, when the config shape is unrecognized', () => {
    const result = computeTypographyRepairEdits({ packageJsonSource: REAL_PACKAGE_JSON, tailwindConfigSource: 'export default {}' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tailwind-config-shape-not-recognized');
  });
});

describe('detectMissingTypographyPlugin — real evidence, in cheapest-first order', () => {
  const BLOG_POST_TEMPLATE = 'src/_includes/layouts/blog-post.njk';
  const glossaryTerm = '<div class="prose prose-lg prose-gray max-w-none">{{ content | safe }}</div>';

  function deps(overrides = {}) {
    return {
      fetchTailwindConfig: async () => REAL_TAILWIND_CONFIG,
      fetchTree: async () => ({ files: [BLOG_POST_TEMPLATE, 'src/_data/glossary.js'] }),
      fetchFile: async (path) => (path === BLOG_POST_TEMPLATE ? glossaryTerm : null),
      fetchPage: async () => '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
      fetchStylesheet: async () => '.max-w-none{a}', // no .prose defined — the real live-site finding
      pageUrl: 'https://zunkireelabs.com',
      ...overrides,
    };
  }

  test('THE REAL FINDING: confirms the repair when templates use prose but the live site ships none', async () => {
    const result = await detectMissingTypographyPlugin({}, deps());
    assert.equal(result.reason, 'confirmed');
    assert.deepEqual(result.usingProse, [BLOG_POST_TEMPLATE]);
    assert.equal(result.package, '@tailwindcss/typography');
  });

  test('already configured — nothing to detect, no repo scan needed', async () => {
    let scanned = false;
    const result = await detectMissingTypographyPlugin({}, deps({
      fetchTailwindConfig: async () => "import typography from '@tailwindcss/typography';\nexport default { plugins: [typography] }",
      fetchTree: async () => { scanned = true; return { files: [] }; },
    }));
    assert.equal(result, null);
    assert.equal(scanned, false, 'no need to scan the repo once the config already has it');
  });

  test('no template anywhere uses a prose class — nothing to repair', async () => {
    const result = await detectMissingTypographyPlugin({}, deps({ fetchFile: async () => '<div class="max-w-none">plain body copy</div>' }));
    assert.equal(result, null);
  });

  test('does not match an unrelated identifier that merely contains "prose" as a substring', async () => {
    const result = await detectMissingTypographyPlugin({}, deps({ fetchFile: async () => '<div class="verboseness">unrelated content</div>' }));
    assert.equal(result, null);
  });

  test('the live site already ships .prose from some other source — nothing to repair', async () => {
    const result = await detectMissingTypographyPlugin({}, deps({ fetchStylesheet: async () => '.prose{color:red}.max-w-none{a}' }));
    assert.equal(result, null);
  });

  test('an unreachable live site is reported distinctly, never as "confirmed" on missing evidence', async () => {
    const result = await detectMissingTypographyPlugin({}, deps({ fetchPage: async () => null }));
    assert.equal(result.reason, 'unreachable');
  });

  test('not a Tailwind site at all (no config file) — nothing this repair knows how to fix', async () => {
    const result = await detectMissingTypographyPlugin({}, deps({ fetchTailwindConfig: async () => null }));
    assert.equal(result, null);
  });
});
