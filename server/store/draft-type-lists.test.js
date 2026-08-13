import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// web/src/components/DraftModal.jsx hand-mirrors two server-side facts:
// which action types have a real merge strategy (MERGE_MANDATORY_TYPES) and
// which have no implementer at all (ADVISORY_ONLY_TYPES). Both had already
// drifted in production:
//
//   - MERGE_MANDATORY_TYPES: qa-content/analytics-install/breadcrumbs/
//     schema-repair/alt-text were added server-side and never mirrored, so
//     the modal offered "Mark Implemented manually" for five types whose
//     UPDATE markDraftImplemented() then refused — a button that could only
//     ever fail.
//   - ADVISORY_ONLY_TYPES: duplicate-id-fix stayed listed as "no implementer
//     registered" for a day after backend.js started handling it, which made
//     the backend's real push/preview/merge path unreachable — the human's
//     Push Branch click is its only entry point (risk-tiers.js keeps that
//     generator at 'manual', so the auto-chain never reaches it either).
//
// Neither drift could fail a test, because nothing compared the two sides.
// This file is that comparison. It parses the JSX as text rather than
// importing it (the modal pulls in React/lucide, which a node:test server
// run has no business loading) — the arrays are plain literals, so a regex
// is sufficient and keeps this test dependency-free.
const HERE = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = join(HERE, '../../web/src/components/DraftModal.jsx');

function arrayLiteralFromJsx(source, constName) {
  const match = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(match, `${constName} not found in DraftModal.jsx — was it renamed? Update this test with it.`);
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('DraftModal.jsx mirrors of server-side action-type lists', () => {
  const source = readFileSync(MODAL_PATH, 'utf8');

  test('MERGE_MANDATORY_TYPES matches server/store/drafts.js exactly', async () => {
    const { MERGE_MANDATORY_TYPES } = await import('./drafts.js');
    const clientList = arrayLiteralFromJsx(source, 'MERGE_MANDATORY_TYPES');
    assert.deepEqual(
      [...clientList].sort(),
      [...MERGE_MANDATORY_TYPES].sort(),
      'DraftModal.jsx\'s MERGE_MANDATORY_TYPES has drifted from the server\'s. Any type the server treats as merge-mandatory must be hidden from the "Mark Implemented manually" button, or that button fails silently.'
    );
  });

  test('ADVISORY_ONLY_TYPES lists only generators with no implementer registered', async () => {
    const { getImplementerForGenerator } = await import('../implementers/registry.js');
    for (const actionType of arrayLiteralFromJsx(source, 'ADVISORY_ONLY_TYPES')) {
      assert.equal(
        await getImplementerForGenerator(actionType),
        null,
        `"${actionType}" is in DraftModal's ADVISORY_ONLY_TYPES but an implementer IS registered for it. The UI would hide Push Branch on a path that really works — remove it from that list (see PARTIAL_AUTO_APPLY_TYPES if it only auto-applies a narrow safe shape).`
      );
    }
  });

  test('PARTIAL_AUTO_APPLY_TYPES lists only generators that DO have an implementer', async () => {
    const { getImplementerForGenerator } = await import('../implementers/registry.js');
    for (const actionType of arrayLiteralFromJsx(source, 'PARTIAL_AUTO_APPLY_TYPES')) {
      assert.notEqual(
        await getImplementerForGenerator(actionType),
        null,
        `"${actionType}" is in PARTIAL_AUTO_APPLY_TYPES but no implementer is registered — the modal would offer a Push Branch that can only fail with "No implementer wired".`
      );
    }
  });
});
