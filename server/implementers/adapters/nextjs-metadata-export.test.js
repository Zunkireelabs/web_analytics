import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeChange, __testables } from './nextjs-metadata-export.js';

const { findMetadataObjectRange, valuesFromDraft } = __testables;

// A trimmed, real shape (Admizz Education's src/app/about/page.tsx,
// 2026-09-08) — static metadata export, alternates.canonical, and a nested
// openGraph object, exactly the pattern this adapter exists for.
const PAGE_FIXTURE = `import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Us | Admizz Education",
  description: "Top education consultancy providing expert study abroad guidance.",
  alternates: {
    canonical: "https://admizzeducation.com/about",
  },
  openGraph: {
    title: "About Us | Admizz Education",
    description: "Top education consultancy providing expert study abroad guidance.",
    url: "https://admizzeducation.com/about",
    siteName: "Admizz Education",
    images: ["/images/og/stuyabroad.webp"],
    type: "website",
  },
};

export default function AboutPage() {
  return <main>{ /* real page content, with a { and } of its own */ }</main>;
}
`;

const NO_METADATA_FIXTURE = `export default async function generateMetadata() {
  return { title: "dynamic" };
}
`;

const NO_ALTERNATES_FIXTURE = `export const metadata: Metadata = {
  title: "Home",
  description: "desc",
};
`;

// Real shape (Admizz Education's src/app/birgunj/page.tsx, 2026-09-11) — the
// title/canonical fields aren't literal strings at all, they're references
// into a separate shared data file (`birgunjData.meta.title`). Neither
// findScalarFieldRange nor the confirmed-existing-alternates check above
// applies here — this is the case scalarFieldKeyExists exists for.
const EXTERNAL_DATA_REF_FIXTURE = `import { cityData } from "@/data/cities/birgunj";

export const metadata: Metadata = {
  title: cityData.meta.title,
  description: cityData.meta.description,
  alternates: {
    canonical: cityData.meta.canonical,
  },
};
`;

const site = {
  id: 8862,
  url_file_map: {
    pages: {
      '/about': { file: 'src/app/about/page.tsx', adapters: { 'meta-title': { id: 'nextjs-metadata-export' }, canonical: { id: 'nextjs-metadata-export' }, 'open-graph': { id: 'nextjs-metadata-export' }, schema: { id: 'nextjs-metadata-export' } } },
      '/home-no-alternates': { file: 'src/app/home-no-alternates/page.tsx', adapters: { canonical: { id: 'nextjs-metadata-export' } } },
      '/dynamic': { file: 'src/app/dynamic/page.tsx', adapters: { 'meta-title': { id: 'nextjs-metadata-export' } } },
      '/birgunj': { file: 'src/app/birgunj/page.tsx', adapters: { 'meta-title': { id: 'nextjs-metadata-export' }, canonical: { id: 'nextjs-metadata-export' } } },
    },
  },
};

const fetchPage = async () => ({ content: PAGE_FIXTURE });
const fetchDynamic = async () => ({ content: NO_METADATA_FIXTURE });
const fetchNoAlternates = async () => ({ content: NO_ALTERNATES_FIXTURE });
const fetchExternalDataRef = async () => ({ content: EXTERNAL_DATA_REF_FIXTURE });

describe('findMetadataObjectRange', () => {
  test('finds the real export const metadata object, not the JSX braces below it', () => {
    const range = findMetadataObjectRange(PAGE_FIXTURE);
    assert.ok(range);
    const slice = PAGE_FIXTURE.slice(range.start, range.end + 1);
    assert.ok(slice.startsWith('{'));
    assert.ok(slice.includes('openGraph'));
    assert.ok(!slice.includes('AboutPage'));
  });

  test('no static metadata export -> null, not a guess', () => {
    assert.equal(findMetadataObjectRange(NO_METADATA_FIXTURE), null);
  });
});

describe('valuesFromDraft', () => {
  test('meta-title requires a selected title', () => {
    const r = valuesFromDraft('meta-title', { titles: ['a', 'b'] });
    assert.equal(r.ok, false);
  });

  test('open-graph refuses unverified placeholder fields', () => {
    const r = valuesFromDraft('open-graph', { ogTitle: 'x', placeholderFields: ['ogTitle'] });
    assert.equal(r.ok, false);
  });
});

describe('computeChange', () => {
  test('meta-title: splices title and description in place', async () => {
    const r = await computeChange(site, {
      action_type: 'meta-title',
      content: { page: 'https://admizzeducation.com/about', selectedTitle: 'New Title | Admizz', metaDescription: 'New description.' },
    }, fetchPage);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/app/about/page.tsx');
    assert.ok(r.newContent.includes('title: "New Title | Admizz"'));
    assert.ok(r.newContent.includes('description: "New description.'));
    // Untouched fields survive.
    assert.ok(r.newContent.includes('openGraph'));
    assert.ok(r.newContent.includes('AboutPage'));
  });

  test('canonical: splices the nested alternates.canonical field only', async () => {
    const r = await computeChange(site, {
      action_type: 'canonical',
      content: { page: 'https://admizzeducation.com/about', canonicalUrl: 'https://admizzeducation.com/about/' },
    }, fetchPage);
    assert.equal(r.ok, true);
    assert.ok(r.newContent.includes('canonical: "https://admizzeducation.com/about/"'));
    // The top-level title (identical string, different field) is untouched.
    assert.ok(r.newContent.includes('title: "About Us | Admizz Education"'));
  });

  test('open-graph: splices nested openGraph.title/description only', async () => {
    const r = await computeChange(site, {
      action_type: 'open-graph',
      content: { page: 'https://admizzeducation.com/about', ogTitle: 'New OG Title', ogDescription: 'New OG description.' },
    }, fetchPage);
    assert.equal(r.ok, true);
    assert.ok(r.newContent.includes('title: "New OG Title"'));
    assert.ok(r.newContent.includes('description: "New OG description."'));
    // The sibling top-level title is untouched — same field name, different object.
    assert.ok(r.newContent.includes('title: "About Us | Admizz Education"'));
  });

  test('no adapter config for this page -> honest no-file-mapping, not a crash', async () => {
    const r = await computeChange(site, {
      action_type: 'meta-title',
      content: { page: 'https://admizzeducation.com/nowhere', selectedTitle: 'x' },
    }, fetchPage);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });

  test('page uses generateMetadata() instead of a static export -> no-insertion-marker, never guessed', async () => {
    const r = await computeChange(site, {
      action_type: 'meta-title',
      content: { page: 'https://admizzeducation.com/dynamic', selectedTitle: 'x' },
    }, fetchDynamic);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('canonical with no existing "alternates" object -> refuses rather than inventing one', async () => {
    const r = await computeChange(site, {
      action_type: 'canonical',
      content: { page: 'https://admizzeducation.com/home-no-alternates', canonicalUrl: 'https://admizzeducation.com/' },
    }, fetchNoAlternates);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
    assert.match(r.error, /alternates/);
  });

  test('title sourced from an external data-file reference (not a string literal) -> refuses instead of inserting a duplicate key', async () => {
    const r = await computeChange(site, {
      action_type: 'meta-title',
      content: { page: 'https://admizzeducation.com/birgunj', selectedTitle: 'New Title' },
    }, fetchExternalDataRef);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non-literal-existing-value');
    // Must not silently produce a file with two "title:" keys — the
    // original reference-backed field, and duplicate splices, and
    // insertNewScalarField was never called with useful output to check.
  });

  test('canonical sourced from an external data-file reference -> refuses, does not touch the reference or duplicate the key', async () => {
    const r = await computeChange(site, {
      action_type: 'canonical',
      content: { page: 'https://admizzeducation.com/birgunj', canonicalUrl: 'https://admizzeducation.com/birgunj' },
    }, fetchExternalDataRef);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non-literal-existing-value');
  });

  test('schema has no metadata-export equivalent — refused, not silently no-op', async () => {
    const r = await computeChange(site, {
      action_type: 'schema',
      content: { page: 'https://admizzeducation.com/about', jsonLd: { '@type': 'Thing' } },
    }, fetchPage);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-config');
  });
});
