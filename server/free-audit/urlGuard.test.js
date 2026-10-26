import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPublicIp } from './urlGuard.js';
import { createRateLimiter } from './rateLimit.js';

const blocked = (u) => assert.rejects(assertPublicUrl(new URL(u)), { code: 'blocked_target' });

test('blocks loopback, private, link-local and metadata IPs', async () => {
  for (const u of [
    'http://127.0.0.1/', 'http://localhost/', 'http://sub.localhost/', 'http://10.1.2.3/',
    'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[fd00::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
  ]) await blocked(u);
});

test('blocks obfuscated IP forms (the URL parser normalizes them)', async () => {
  for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.1/']) await blocked(u);
});

test('blocks internal names, odd ports, credentials and non-http schemes', async () => {
  await blocked('http://intranet/');
  await blocked('http://printer.local/');
  await blocked('http://db.internal/');
  await blocked('https://example.com:8080/');
  await blocked('https://user:pass@example.com/');
  await blocked('ftp://example.com/');
});

test('allows public IPs and the default ports', async () => {
  await assertPublicUrl(new URL('https://1.1.1.1/'));
  await assertPublicUrl(new URL('http://8.8.8.8:80/'));
  assert.equal(isPublicIp('93.184.216.34'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('rate limiter allows max hits per window, then reports retry seconds', () => {
  const take = createRateLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(take('a'), 0);
  assert.equal(take('a'), 0);
  assert.ok(take('a') > 0);
  assert.equal(take('b'), 0);
});
