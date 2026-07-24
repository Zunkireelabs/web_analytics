import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasHashMarker, spliceHashBlock, getHashMarkerContent, validateNginxBraces } from './hash-marker-merge.js';

const NGINX_FIXTURE = `server {
    listen 80;
    server_name example.com;

    # SEOAI:SECURITY-HEADERS:START
    # SEOAI:SECURITY-HEADERS:END

    location / {
        try_files $uri /index.html;
    }
}
`;

describe('hasHashMarker', () => {
  test('true when the marker pair exists', () => {
    assert.equal(hasHashMarker(NGINX_FIXTURE, 'SECURITY-HEADERS'), true);
  });

  test('false when the marker is absent', () => {
    assert.equal(hasHashMarker(NGINX_FIXTURE, 'SOMETHING-ELSE'), false);
  });
});

describe('spliceHashBlock', () => {
  test('splices new content between an existing marker pair, preserving the rest of the file', () => {
    const block = 'add_header X-Frame-Options "SAMEORIGIN" always;\nadd_header X-Content-Type-Options "nosniff" always;';
    const result = spliceHashBlock(NGINX_FIXTURE, 'SECURITY-HEADERS', block);
    assert.equal(result.ok, true);
    assert.match(result.newContent, /X-Frame-Options "SAMEORIGIN"/);
    assert.match(result.newContent, /X-Content-Type-Options "nosniff"/);
    assert.match(result.newContent, /listen 80;/);
    assert.match(result.newContent, /try_files \$uri \/index\.html;/);
    assert.equal(result.newContent.startsWith(NGINX_FIXTURE.split('# SEOAI:SECURITY-HEADERS:START')[0]), true);
  });

  test('re-splicing (approving a second draft) replaces the previous block rather than duplicating it', () => {
    const first = spliceHashBlock(NGINX_FIXTURE, 'SECURITY-HEADERS', 'add_header X-Frame-Options "SAMEORIGIN" always;');
    const second = spliceHashBlock(first.newContent, 'SECURITY-HEADERS', 'add_header X-Frame-Options "SAMEORIGIN" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;');
    assert.equal(second.ok, true);
    const occurrences = (second.newContent.match(/X-Frame-Options/g) || []).length;
    assert.equal(occurrences, 1);
    assert.match(second.newContent, /Referrer-Policy/);
  });

  test('fails honestly with no-insertion-marker when the marker pair is missing, without touching the file', () => {
    const noMarkerFile = 'server {\n    listen 80;\n}\n';
    const result = spliceHashBlock(noMarkerFile, 'SECURITY-HEADERS', 'add_header X-Frame-Options "SAMEORIGIN" always;');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-insertion-marker');
  });

  test('reports the previous block content as "before" for an accurate diff', () => {
    const withContent = NGINX_FIXTURE.replace(
      '# SEOAI:SECURITY-HEADERS:START\n    # SEOAI:SECURITY-HEADERS:END',
      '# SEOAI:SECURITY-HEADERS:START\n    add_header X-Frame-Options "SAMEORIGIN" always;\n    # SEOAI:SECURITY-HEADERS:END',
    );
    const result = spliceHashBlock(withContent, 'SECURITY-HEADERS', 'add_header X-Content-Type-Options "nosniff" always;');
    assert.match(result.changedRegion.before, /X-Frame-Options/);
    assert.equal(result.changedRegion.after, 'add_header X-Content-Type-Options "nosniff" always;');
  });
});

describe('getHashMarkerContent', () => {
  test('reads whatever currently sits inside the marker', () => {
    const withContent = NGINX_FIXTURE.replace(
      '# SEOAI:SECURITY-HEADERS:START\n    # SEOAI:SECURITY-HEADERS:END',
      '# SEOAI:SECURITY-HEADERS:START\n    add_header X-Frame-Options "SAMEORIGIN" always;\n    # SEOAI:SECURITY-HEADERS:END',
    );
    assert.match(getHashMarkerContent(withContent, 'SECURITY-HEADERS'), /X-Frame-Options/);
  });

  test('returns null when the marker is absent', () => {
    assert.equal(getHashMarkerContent('server { listen 80; }', 'SECURITY-HEADERS'), null);
  });
});

describe('validateNginxBraces', () => {
  test('ok for balanced braces', () => {
    assert.equal(validateNginxBraces(NGINX_FIXTURE).ok, true);
  });

  test('fails for unbalanced braces', () => {
    const broken = NGINX_FIXTURE.replace('}\n', '');
    const result = validateNginxBraces(broken);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unbalanced-braces');
  });
});
