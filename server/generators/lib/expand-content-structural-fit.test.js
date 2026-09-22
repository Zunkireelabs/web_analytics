import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let files; // path -> raw content string, or undefined for "not found"

mock.module(resolve('../../github/client.js'), {
  namedExports: {
    getFileContent: async (site, path) => {
      const content = files[path];
      return content === undefined ? null : { content, sha: 'abc123' };
    },
    defaultBranchName: (site) => site.repo_default_branch || 'main',
  },
});

const { checkExpandContentStructuralFit } = await import('./expand-content-structural-fit.js');

const PAGE_PATH = 'src/app/study-in-nepal/page.tsx';
const site = {
  repo_owner: 'Zunkireelabs', repo_name: 'admizz-web-dev', repo_default_branch: 'main',
  url_file_map: { pages: { '/study-in-nepal': { file: PAGE_PATH } } },
};

// The real shape confirmed on Admizz Education (site 8862): a page-data-object
// page with a local const passed as data={...} to a shared template, no free
// JSX body of its own.
const PAGE_DATA_OBJECT_SHAPE = `
const nepalData = {
  countryName: "Nepal",
  faqItems: [],
};
export default async function StudyInNepalPage() {
  return <CountryPageTemplate data={nepalData} />;
}
`;

const NORMAL_JSX_SHAPE = `
export default function AboutPage() {
  return (
    <main>
      <h1>About us</h1>
      <p>Real body content goes here.</p>
    </main>
  );
}
`;

beforeEach(() => { files = {}; });

describe('checkExpandContentStructuralFit', () => {
  test('returns ok:false for a page-data-object-shaped page with no free JSX body', async () => {
    files[PAGE_PATH] = PAGE_DATA_OBJECT_SHAPE;
    const result = await checkExpandContentStructuralFit(site, '/study-in-nepal');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'self-closing-root-no-body');
    assert.match(result.detail, /has no free-form body region/);
    assert.match(result.detail, /template change, not a content edit/);
  });

  test('returns ok:true for a normal page with a real JSX body', async () => {
    files[PAGE_PATH] = NORMAL_JSX_SHAPE;
    const result = await checkExpandContentStructuralFit(site, '/study-in-nepal');
    assert.equal(result.ok, true);
  });

  test('returns null (cannot check) when the site has no repo connected', async () => {
    const result = await checkExpandContentStructuralFit({ repo_owner: null, repo_name: null }, '/study-in-nepal');
    assert.equal(result, null);
  });

  test('returns null when there is no url_file_map entry for this page', async () => {
    const result = await checkExpandContentStructuralFit(site, '/not-mapped-anywhere');
    assert.equal(result, null);
  });

  test('returns null when the file fetch fails', async () => {
    // PAGE_PATH intentionally left out of `files`, so getFileContent returns null
    const result = await checkExpandContentStructuralFit(site, '/study-in-nepal');
    assert.equal(result, null);
  });

  test('returns ok:true (defers to the existing apply-time path) for an unrelated structural failure reason', async () => {
    // A file that fails detection for a DIFFERENT reason than the two this
    // check specifically targets — e.g. a genuinely unsupported file type.
    files['src/app/weird/page.xyz'] = 'not a real file';
    const weirdSite = { ...site, url_file_map: { pages: { '/weird': { file: 'src/app/weird/page.xyz' } } } };
    const result = await checkExpandContentStructuralFit(weirdSite, '/weird');
    assert.equal(result.ok, true);
  });
});
