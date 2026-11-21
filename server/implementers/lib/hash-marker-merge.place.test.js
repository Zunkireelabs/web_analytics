import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureHashMarker, findServingServerBlock, locationsDroppingServerHeaders, spliceHashBlock, validateNginxBraces } from './hash-marker-merge.js';

const CONF = `# a comment that mentions the word location
map $a $b {
    default "";
}
server {
    listen 80;
    return 301 https://x$request_uri;
}
server {
    listen 443;
    root /srv;
    add_header Cache-Control $cc;
    location ~ ^/a/?$ { return 301 /services/#top; }
    # a comment that says location ~ x { add_header Y z; }
    location / {
        try_files $uri =404;
    }
}
`;

test('places the pair inside the server block that serves the site, not the redirect-only one', () => {
  const r = ensureHashMarker(CONF, 'SECURITY-HEADERS');
  assert.equal(r.ok && r.inserted, true);
  const at = r.content.indexOf('SEOAI:SECURITY-HEADERS:START');
  const second = r.content.indexOf('server {', r.content.indexOf('server {') + 1);
  assert.ok(at > second && at < r.content.indexOf('listen 443'));
  assert.ok(at > r.content.indexOf('return 301 https'), 'not placed in the redirect-only block');
  const sp = spliceHashBlock(r.content, 'SECURITY-HEADERS', '    add_header X-Frame-Options "SAMEORIGIN" always;');
  assert.equal(sp.ok, true);
  assert.equal(validateNginxBraces(sp.newContent).ok, true);
});
test('an existing marker is left alone', () => {
  const withMarker = CONF.replace('root /srv;', 'root /srv;\n    # SEOAI:SECURITY-HEADERS:START\n    # SEOAI:SECURITY-HEADERS:END');
  const r = ensureHashMarker(withMarker, 'SECURITY-HEADERS');
  assert.equal(r.inserted, false);
  assert.equal(r.content, withMarker);
});
test('"#" inside a redirect target is not a comment, and comment text is never read as config', () => {
  assert.ok(findServingServerBlock(CONF));
  assert.deepEqual(locationsDroppingServerHeaders(CONF), []);
});
test('finds the locations that set their own add_header (nginx would drop server-level headers there)', () => {
  const c = CONF.replace('location / {', 'location / {\n        add_header Cache-Control no-cache;');
  assert.deepEqual(locationsDroppingServerHeaders(c), ['/']);
});
test('no serving server block -> refusal, nothing invented', () => {
  const r = ensureHashMarker('server {\n  listen 80;\n  return 301 /x;\n}\n', 'COMPRESSION');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-insertion-marker');
});
