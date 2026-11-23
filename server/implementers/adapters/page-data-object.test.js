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

// Admizz's generated blog/answer pages (e.g. src/app/uk-student-visa-cost-2027/page.tsx): a JSON-style local `post`
// object (quoted keys) spread into GeneratedBlogPost — `{...post}` instead of `data={post}`.
const SPREAD_FIXTURE = `import type { Metadata } from "next";
import GeneratedBlogPost from "@/components/GeneratedBlogPost";

const post = {
  "title": "UK Student Visa Cost 2027",
  "slug": "uk-student-visa-cost-2027",
  "sections": [
    { "heading": "The three costs", "body": "Three separate amounts." }
  ],
  "faqItems": [
    {
      "answer": "GBP 558 from outside the UK.",
      "question": "How much is the UK student visa fee?"
    }
  ],
  "publishedAt": "2026-04-24T13:16:00.000Z"
};

export const metadata: Metadata = { title: "UK Student Visa Cost 2027" };

export default function Page() {
  return <GeneratedBlogPost {...post} />;
}
`;
const SCHEMA_ONLY_FIXTURE = SPREAD_FIXTURE.replace('"publishedAt"', '"faqSchemaOnly": true,\n  "publishedAt"');
const SPREAD_PROPS_FIXTURE = `import Wrapper from "@/components/Wrapper";
export default function Page(props) {
  return <Wrapper {...props} />;
}
`;
const SPREAD_IMPORTED_FIXTURE = `import { post } from "./post";
import GeneratedBlogPost from "@/components/GeneratedBlogPost";
export default function Page() {
  return <GeneratedBlogPost {...post} />;
}
`;
const LOWERCASE_SPREAD_FIXTURE = `const rest = { faqItems: [] };
export default function Page() {
  return <div {...rest} />;
}
`;
const spreadSite = {
  id: 8862,
  url_file_map: { pages: {
    '/uk-student-visa-cost-2027': { file: 'src/app/uk-student-visa-cost-2027/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
    '/schema-only': { file: 'src/app/schema-only/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
    '/props': { file: 'src/app/props/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
    '/imported-post': { file: 'src/app/imported-post/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
    '/lower': { file: 'src/app/lower/page.tsx', adapters: { faq: { id: 'page-data-object' } } },
  } },
};
const spreadDraft = (page) => ({ action_type: 'faq', content: { page, items: [{ question: 'Is the IHS refundable?', answer: 'Only in limited cases, per GOV.UK.' }] } });

describe('{...post} spread pages (Admizz GeneratedBlogPost / answers)', () => {
  test('findPageDataObjectRange follows {...post} to the local const, not the JSX', () => {
    const { range, varName } = findPageDataObjectRange(SPREAD_FIXTURE);
    assert.equal(varName, 'post');
    assert.ok(range);
    assert.match(SPREAD_FIXTURE.slice(range.start, range.end), /"faqItems"/);
    assert.doesNotMatch(SPREAD_FIXTURE.slice(range.start, range.end), /GeneratedBlogPost/);
  });

  test('data={x} still wins over a spread when both are present', () => {
    const c = 'const a = { faqItems: [] };\nconst b = { faqItems: [] };\nexport default function P() { return <X data={a} {...b} />; }\n';
    assert.equal(findPageDataObjectRange(c).varName, 'a');
  });

  test('faq: appends inside the existing "faqItems" array, hand-authored item untouched, structure intact', async () => {
    const r = await computeChange(spreadSite, spreadDraft('/uk-student-visa-cost-2027'), async () => ({ content: SPREAD_FIXTURE }));
    assert.equal(r.ok, true);
    assert.match(r.newContent, /How much is the UK student visa fee\?/);
    assert.match(r.newContent, /Is the IHS refundable\?/);
    assert.match(r.newContent, /"faqItems"\s*:\s*\[\s*\{/, 'repo validate-content.mjs needs this exact opening to survive');
    assert.equal(r.newContent.includes('<GeneratedBlogPost {...post} />'), true, 'JSX untouched');
    assert.equal(r.renderMode, 'visible');
    // everything outside the faqItems array is byte-identical
    const strip = (s) => s.replace(/"faqItems"\s*:\s*\[[\s\S]*?\]\s*,\n/, '');
    assert.equal(strip(r.newContent), strip(SPREAD_FIXTURE));
  });

  test('faqSchemaOnly: true is refused — items would feed schema with no visible FAQ', async () => {
    const r = await computeChange(spreadSite, spreadDraft('/schema-only'), async () => ({ content: SCHEMA_ONLY_FIXTURE }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'faq-schema-only');
  });

  test('a spread of props with no local const is refused, never guessed', async () => {
    const r = await computeChange(spreadSite, spreadDraft('/props'), async () => ({ content: SPREAD_PROPS_FIXTURE }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('a spread of an imported object is refused rather than following the import', async () => {
    const r = await computeChange(spreadSite, spreadDraft('/imported-post'), async () => ({ content: SPREAD_IMPORTED_FIXTURE }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-insertion-marker');
  });

  test('a spread on a lower-case DOM element is not a template hand-off', async () => {
    const r = await computeChange(spreadSite, spreadDraft('/lower'), async () => ({ content: LOWERCASE_SPREAD_FIXTURE }));
    assert.equal(r.ok, false);
  });
});
