import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeChange, __testables } from './page-data-object.js';

const { findPageDataObjectRange } = __testables;

// A trimmed, real shape (Admizz Education's src/app/study-in-australia/
// page.tsx, 2026-09-11) — a local data object passed as `data={...}` to a
// shared template, with a hand-authored faqItems array already on it.
const PAGE_FIXTURE = `import type { Metadata } from "next";
import CountryPageTemplate from "@/components/ui/CountryPageTemplate";

export const metadata: Metadata = {
  title: "Study in Australia - Admizz Education",
};

const ausData: CountryPageData = {
  countryName: "Australia",
  quickFacts: [
    { label: "Capital", value: "Canberra" },
  ],
  faqItems: [
    { question: "Is Australia good for students?", answer: "Yes, world-ranked universities." },
    { question: "How much does it cost?", answer: "AUD 20,000-50,000 per year." },
  ],
};

export default async function StudyInAustraliaPage() {
  return <CountryPageTemplate data={ausData} blogPosts={[]} />;
}
`;

// A local data object (same shape the adapter follows fine) that simply has
// no faqItems field on it yet — the field-level gap this adapter must
// refuse rather than fabricate a starting point for.
const NO_FAQ_FIXTURE = `import CityLandingTemplate from "@/components/city-landing/CityLandingTemplate";

const cityData = {
  city: "Birgunj",
  hero: { heading: "Birgunj" },
};

export default function BirgunjPage() {
  return <CityLandingTemplate data={cityData} />;
}
`;

// A page whose template prop references an imported var with no local
// declaration in this file — this adapter does not follow imports.
const IMPORTED_DATA_FIXTURE = `import { externalData } from "./data";
import SomeTemplate from "@/components/SomeTemplate";

export default function Page() {
  return <SomeTemplate data={externalData} />;
}
`;

const site = {
  id: 8862,
  url_file_map: {
    pages: {
      '/study-in-australia': { file: 'src/app/study-in-australia/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
      '/birgunj': { file: 'src/app/birgunj/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
      '/imported': { file: 'src/app/imported/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
    },
  },
};

const fetchPage = async () => ({ content: PAGE_FIXTURE });
const fetchNoFaq = async () => ({ content: NO_FAQ_FIXTURE });
const fetchImported = async () => ({ content: IMPORTED_DATA_FIXTURE });

describe('findPageDataObjectRange', () => {
  test('follows data={ausData} to the real local object, not the JSX below it', () => {
    const { range, varName } = findPageDataObjectRange(PAGE_FIXTURE);
    assert.equal(varName, 'ausData');
    assert.ok(range);
    const slice = PAGE_FIXTURE.slice(range.start, range.end + 1);
    assert.ok(slice.includes('faqItems'));
    assert.ok(!slice.includes('StudyInAustraliaPage'));
  });

  test('data prop referencing an import with no local declaration -> null, not a guess', () => {
    const { range, error } = findPageDataObjectRange(IMPORTED_DATA_FIXTURE);
    assert.equal(range, null);
    assert.match(error, /externalData/);
  });
});

describe('computeChange', () => {
  test('faq: appends new AI-managed items inside the existing faqItems array, hand-authored items untouched', async () => {
    const r = await computeChange(site, {
      action_type: 'faq',
      content: {
        page: 'https://admizzeducation.com/study-in-australia',
        items: [{ question: 'What is the visa process?', answer: 'Apply for subclass 500.' }],
      },
    }, fetchPage);
    assert.equal(r.ok, true);
    assert.equal(r.filePath, 'src/app/study-in-australia/page.tsx');
    assert.ok(r.newContent.includes('What is the visa process?'));
    // Hand-authored items survive verbatim.
    assert.ok(r.newContent.includes('Is Australia good for students?'));
    assert.ok(r.newContent.includes('How much does it cost?'));
    assert.equal(r.renderMode, 'visible');
  });

  test('page with no existing faqItems array -> refuses honestly, never fabricates a starting point', async () => {
    const r = await computeChange(site, {
      action_type: 'faq',
      content: { page: 'https://admizzeducation.com/birgunj', items: [{ question: 'Q', answer: 'A' }] },
    }, fetchNoFaq);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
    assert.match(r.error, /faqItems/);
  });

  test('data prop references an import, not a local const -> refuses rather than following the import', async () => {
    const r = await computeChange(site, {
      action_type: 'faq',
      content: { page: 'https://admizzeducation.com/imported', items: [{ question: 'Q', answer: 'A' }] },
    }, fetchImported);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('action types other than faq are refused, not silently no-op', async () => {
    const r = await computeChange(site, {
      action_type: 'schema',
      content: { page: 'https://admizzeducation.com/study-in-australia', jsonLd: { '@type': 'Thing' } },
    }, fetchPage);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-config');
  });

  test('no adapter config for this page -> honest no-file-mapping, not a crash', async () => {
    const r = await computeChange(site, {
      action_type: 'faq',
      content: { page: 'https://admizzeducation.com/nowhere', items: [{ question: 'Q', answer: 'A' }] },
    }, fetchPage);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-file-mapping');
  });
});
