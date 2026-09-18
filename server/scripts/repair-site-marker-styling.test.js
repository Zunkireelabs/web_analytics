import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repairSiteMarkerStyling } from './repair-site-marker-styling.js';

// The site's real captured FAQ template — deliberately built for a full-bleed
// page SECTION (the site's homepage FAQ), the same shape as a real capture.
const SITE_TEMPLATES = {
  faq: {
    wrapper: '<dl class="container-custom py-12 md:py-20">\n{{ROWS}}\n</dl>',
    row: '  <dt class="text-2xl md:text-3xl font-normal text-gray-900">{{QUESTION}}</dt>\n  <dd class="text-lg md:text-xl text-gray-600 leading-relaxed max-w-2xl">{{ANSWER}}</dd>',
  },
  qaContent: {
    wrapper: '<div class="container-custom py-12 md:py-20">\n{{ROWS}}\n</div>',
    row: '  <details>\n    <summary><h3 class="text-2xl md:text-3xl">{{QUESTION}}</h3></summary>\n    <div class="text-lg">{{ANSWER}}</div>\n  </details>',
  },
};

async function writeRepo(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'marker-styling-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, 'src', rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

// Reported 2026-09-09: PROSE_TEMPLATES had entries for EXPANDEDCONTENT and
// QACONTENT but not FAQ, so a blog post's FAQ marker fell through to the
// site's raw page-section template above and carried `container-custom
// py-12 md:py-20` into the post's own prose column.
describe('repairSiteMarkerStyling — FAQ on a blog (.md) post gets the same bare prose treatment as QACONTENT/EXPANDEDCONTENT', () => {
  const blogFaqRegion = [
    '<!-- SEOAI:FAQ:START -->',
    '<dl class="container-custom py-12 md:py-20">',
    '  <dt class="text-2xl md:text-3xl font-normal text-gray-900">Why is patient data security important for healthcare providers?</dt>',
    '  <dd class="text-lg md:text-xl text-gray-600 leading-relaxed max-w-2xl">Because compromised data leads to identity theft and loss of trust.</dd>',
    '</dl>',
    '<!-- SEOAI:FAQ:END -->',
  ].join('\n');

  test('a blog post FAQ marker is re-rendered bare, with no page-section sizing classes', async () => {
    const dir = await writeRepo({ 'blog/patient-data-security.md': `# Post\n\n${blogFaqRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, SITE_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'blog', 'patient-data-security.md'), 'utf8');
      assert.doesNotMatch(out, /container-custom/);
      assert.doesNotMatch(out, /text-2xl|max-w-2xl/);
      assert.match(out, /<dt>Why is patient data security important for healthcare providers\?<\/dt>/);
      assert.match(out, /<dd>Because compromised data leads to identity theft and loss of trust\.<\/dd>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the same FAQ marker on a real .njk page (not prose-hosted) keeps the site\'s real section styling', async () => {
    const dir = await writeRepo({ 'pages/services.njk': `<main>\n${blogFaqRegion}\n</main>\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, SITE_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 0); // already matches handler.template byte-for-byte
      const out = await readFile(path.join(dir, 'src', 'pages', 'services.njk'), 'utf8');
      assert.match(out, /container-custom py-12 md:py-20/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('QACONTENT on the same blog post still gets its own existing bare treatment (regression guard)', async () => {
    const region = [
      '<!-- SEOAI:QACONTENT:START -->',
      '<div class="container-custom py-12 md:py-20">',
      '  <details>',
      '    <summary><h3 class="text-2xl md:text-3xl">How do I get in touch?</h3></summary>',
      '    <div class="text-lg">Email or call us.</div>',
      '  </details>',
      '</div>',
      '<!-- SEOAI:QACONTENT:END -->',
    ].join('\n');
    const dir = await writeRepo({ 'blog/contact-info.md': `# Post\n\n${region}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, SITE_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'blog', 'contact-info.md'), 'utf8');
      assert.doesNotMatch(out, /container-custom/);
      assert.match(out, /<h3>How do I get in touch\?<\/h3>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The retroactive half of the 2026-09-15 expand-content prose fix: every
// EXPANDEDCONTENT block shipped before marker-merge.js's proseStyleFor
// existed has a bare, unstyled <p>/<ul>/<li>/<a> body — normaliseTables
// above already retroactively fixes tables the same way; normaliseProse
// extends that to prose, gated on a real designProfile being passed in.
describe('repairSiteMarkerStyling — retroactively grounds EXPANDEDCONTENT prose (normaliseProse)', () => {
  const TEMPLATES_WITH_EXPAND = { expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2>\n{{BODY}}' } };
  const REAL_PROFILE = {
    typography: { body: 'text-lg text-gray-600 leading-relaxed', link: 'text-zunkiree-600 hover:underline' },
    components: { list: { wrapper: 'space-y-2 my-4', item: 'flex items-start gap-2' } },
  };
  const bareRegion = [
    '<!-- SEOAI:EXPANDEDCONTENT:START -->',
    '<h2>Why It Matters</h2>',
    '<p>See <a href="https://example.com/docs">our docs</a> for more.</p>',
    '<ul><li>First point</li><li>Second point</li></ul>',
    '<!-- SEOAI:EXPANDEDCONTENT:END -->',
  ].join('\n');

  test('with a real design profile, a bare shipped body gets the site\'s real classes added', async () => {
    const dir = await writeRepo({ 'blog/post.md': `# Post\n\n${bareRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, TEMPLATES_WITH_EXPAND, { write: true, designProfile: REAL_PROFILE });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'blog', 'post.md'), 'utf8');
      assert.match(out, /<p class="text-lg text-gray-600 leading-relaxed">/);
      assert.match(out, /<a href="https:\/\/example\.com\/docs" class="text-zunkiree-600 hover:underline">/);
      assert.match(out, /<ul class="space-y-2 my-4">/);
      assert.match(out, /<li class="flex items-start gap-2">First point<\/li>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('with no design profile given, the body is left exactly as bare as it already was — no behavior change', async () => {
    const dir = await writeRepo({ 'blog/post.md': `# Post\n\n${bareRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, TEMPLATES_WITH_EXPAND, { write: true });
      const out = await readFile(path.join(dir, 'src', 'blog', 'post.md'), 'utf8');
      // Rewritten (blockSafeRow/whitespace normalization still applies), but
      // no class attributes are introduced onto p/ul/li/a.
      assert.doesNotMatch(out, /<p class=/);
      assert.doesNotMatch(out, /<ul class=/);
      assert.doesNotMatch(out, /<a[^>]+class=/);
      assert.ok(result.changedRegions >= 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a tag that already carries a real class is never overwritten by the generic one', async () => {
    const alreadyClassedRegion = [
      '<!-- SEOAI:EXPANDEDCONTENT:START -->',
      '<h2>Why It Matters</h2>',
      '<p class="custom-existing-class">Already styled by a prior run or a hand-captured template.</p>',
      '<!-- SEOAI:EXPANDEDCONTENT:END -->',
    ].join('\n');
    const dir = await writeRepo({ 'blog/post.md': `# Post\n\n${alreadyClassedRegion}\n` });
    try {
      await repairSiteMarkerStyling(dir, TEMPLATES_WITH_EXPAND, { write: true, designProfile: REAL_PROFILE });
      const out = await readFile(path.join(dir, 'src', 'blog', 'post.md'), 'utf8');
      assert.match(out, /<p class="custom-existing-class">/);
      assert.doesNotMatch(out, /text-lg text-gray-600/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Confirmed live on site 1 (2026-09-18): src/pages/privacy-policy-
// zunkiree-labs.njk's EXPANDEDCONTENT wrapper still carried `py-12
// md:py-20` section-scale spacing. The old hostIsProse check was
// file.endsWith('.md') only, so a legal page (.njk, not .md) always fell
// through to the site's raw page-section template — the same defect the
// 2026-09-09 FAQ fix above exists to prevent, just for a page TYPE the
// check never recognised rather than a marker TYPE it never recognised.
const FULL_SECTION_EXPAND_TEMPLATES = {
  expandContent: {
    wrapper: '<div class="container-custom py-12 md:py-20">\n{{ROWS}}\n</div>',
    row: '  <section class="gap-3">\n    <h2 class="text-3xl md:text-4xl lg:text-5xl font-normal text-gray-900">{{HEADING}}</h2>\n    <div class="text-gray-600 leading-relaxed">{{BODY}}</div>\n  </section>',
  },
};

describe('repairSiteMarkerStyling — a legal (.njk) page gets the same bare prose treatment as a blog post', () => {
  const legalExpandedContentRegion = [
    '<!-- SEOAI:EXPANDEDCONTENT:START -->',
    '<section class="py-12 md:py-20">',
    '<h2 class="text-3xl md:text-4xl lg:text-5xl font-normal text-gray-900">Data Retention</h2>',
    '<p>We retain your data only as long as necessary.</p>',
    '</section>',
    '<!-- SEOAI:EXPANDEDCONTENT:END -->',
  ].join('\n');

  test('a privacy-policy.njk page is re-rendered bare, with no page-section sizing classes', async () => {
    const dir = await writeRepo({ 'pages/privacy-policy-zunkiree-labs.njk': `---\npermalink: /privacy/\n---\n\n${legalExpandedContentRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, FULL_SECTION_EXPAND_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'pages', 'privacy-policy-zunkiree-labs.njk'), 'utf8');
      assert.doesNotMatch(out, /py-12 md:py-20/);
      assert.doesNotMatch(out, /container-custom/);
      assert.match(out, /<h2>Data Retention<\/h2>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a terms-of-service page is also recognised as a prose host', async () => {
    const dir = await writeRepo({ 'pages/zunkiree-labs-terms-of-service.njk': `---\npermalink: /terms/\n---\n\n${legalExpandedContentRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, FULL_SECTION_EXPAND_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'pages', 'zunkiree-labs-terms-of-service.njk'), 'utf8');
      assert.doesNotMatch(out, /py-12 md:py-20/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a non-legal, non-blog .njk page still gets the full raw section template', async () => {
    const dir = await writeRepo({ 'pages/about.njk': `---\npermalink: /about/\n---\n\n${legalExpandedContentRegion}\n` });
    try {
      const result = await repairSiteMarkerStyling(dir, FULL_SECTION_EXPAND_TEMPLATES, { write: true });
      assert.equal(result.changedRegions, 1);
      const out = await readFile(path.join(dir, 'src', 'pages', 'about.njk'), 'utf8');
      assert.match(out, /container-custom py-12 md:py-20/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
