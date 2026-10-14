import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSoftNotFoundFallback, patchSoftNotFoundFallback } from './soft-404-inject.js';

const VULNERABLE_FIXTURE = `server {
    listen 80;
    server_name example.com;

    location / {
        try_files $uri $uri/ $uri.html /index.html;
        add_header Cache-Control "no-cache";
    }
}
`;

const ALREADY_FIXED_FIXTURE = `server {
    location / {
        try_files $uri $uri/ $uri.html /index.html;
        error_page 404 /404.html;
    }
}
`;

const NO_MATCH_FIXTURE = `server {
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
}
`;

const AMBIGUOUS_FIXTURE = `server {
    location / {
        try_files $uri $uri/ $uri.html /index.html;
    }
    location /other/ {
        try_files $uri $uri/ $uri.html /index.html;
    }
}
`;

describe('detectSoftNotFoundFallback', () => {
  test('true when the exact vulnerable fallback line is present', () => {
    assert.equal(detectSoftNotFoundFallback(VULNERABLE_FIXTURE), true);
  });

  test('false when the line is absent', () => {
    assert.equal(detectSoftNotFoundFallback(NO_MATCH_FIXTURE), false);
  });
});

describe('patchSoftNotFoundFallback', () => {
  test('replaces the fallback with a real 404, preserving indentation and everything else', () => {
    const result = patchSoftNotFoundFallback(VULNERABLE_FIXTURE);
    assert.equal(result.ok, true);
    assert.match(result.newContent, /try_files \$uri \$uri\/ \$uri\.html =404;/);
    assert.doesNotMatch(result.newContent, /\/index\.html;/);
    assert.match(result.newContent, /listen 80;/);
    assert.match(result.newContent, /add_header Cache-Control "no-cache";/);
  });

  test('refuses when the file already has its own error_page 404 handling', () => {
    const result = patchSoftNotFoundFallback(ALREADY_FIXED_FIXTURE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-resolved');
  });

  test('refuses rather than guesses when the exact line is not found', () => {
    const result = patchSoftNotFoundFallback(NO_MATCH_FIXTURE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('refuses when the line appears more than once — never guesses which is the real catch-all', () => {
    const result = patchSoftNotFoundFallback(AMBIGUOUS_FIXTURE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous-match');
  });
});
