import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webMcpFinding } from './ai-visibility.js';

describe('webMcpFinding', () => {
  test('null when a manifest is present — nothing to inform about', () => {
    assert.equal(webMcpFinding({ webMcpReadiness: { hasManifest: true }, analyzedCount: 10 }), null);
  });

  test('null when webMcpReadiness itself is null (no real origin could be resolved)', () => {
    assert.equal(webMcpFinding({ webMcpReadiness: null, analyzedCount: 10 }), null);
  });

  test('a real, low-priority, informational-only finding when no manifest is found', () => {
    const finding = webMcpFinding({ webMcpReadiness: { hasManifest: false }, analyzedCount: 7 });
    assert.notEqual(finding, null);
    assert.equal(finding.id, 'ai-visibility:site:webmcp');
    assert.equal(finding.priority, 'low');
    // Never a draftable action — a real manifest requires knowing this
    // site's actual invocable actions, which nothing here can honestly derive.
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.evidence.analyzedPages, 7);
    assert.equal(finding.evidence.hasManifest, false);
  });
});
