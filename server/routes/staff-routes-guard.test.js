import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The staff controls (suspend, reactivate, delete, autonomous fixes, analytics IDs) are reachable only by a
// platform admin: the whole clients router is gated before its first route, and the tenant lifecycle routes
// carry the gate themselves. A client's admin or owner never reaches them, whatever the UI shows.
const src = readFileSync(fileURLToPath(new URL('./clients.js', import.meta.url)), 'utf8');

test('the whole /internal/clients router is platform-admin only, before any route', () => {
  const gate = src.indexOf("router.use(requireAuth, requirePlatformRole('platform_admin'))");
  const firstRoute = src.search(/router\.(get|post|put|patch|delete)\(/);
  assert.ok(gate > -1, 'router-level platform gate is missing');
  assert.ok(gate < firstRoute, 'the gate must come before the first route');
});

test('every tenant lifecycle route names the platform_admin gate itself', () => {
  for (const action of ['suspend', 'reactivate', 'soft-delete', 'hard-delete']) {
    const m = src.match(new RegExp(`router\\.post\\('/internal/tenants/:id/${action}',\\s*requirePlatformRole\\('platform_admin'\\)`));
    assert.ok(m, `${action} is not gated`);
  }
});
