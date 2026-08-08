import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectAndOpenBootstrapPr } from './marker-bootstrap.js';

// Only the two early-return paths that never touch the network are unit
// tested here (no GitHub-mocking convention exists elsewhere in this repo to
// follow for the PR-opening path — see github-ops.js, which is exercised via
// real integration only). Both matter on their own: "nothing to bootstrap"
// and "detection genuinely found nothing safe" must never fall through to a
// network call.
describe('detectAndOpenBootstrapPr — early returns (no network)', () => {
  test('returns already-has-marker without calling GitHub when the marker already exists', async () => {
    const file = 'export default function Page() { return <main>{/* SEOAI:QACONTENT:START */}{/* SEOAI:QACONTENT:END */}</main>; }';
    const result = await detectAndOpenBootstrapPr({ id: 1, repo_owner: 'x', repo_name: 'y' }, 'page.jsx', file, 'QACONTENT');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-has-marker');
  });

  test('returns no-confident-container without calling GitHub when structural detection fails', async () => {
    const file = 'export default function getData() { return { props: {} }; }';
    const result = await detectAndOpenBootstrapPr({ id: 1, repo_owner: 'x', repo_name: 'y' }, 'getServerSideProps.tsx', file, 'QACONTENT');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-confident-container');
    assert.equal(result.detectReason, 'no-jsx-return-found');
  });
});
