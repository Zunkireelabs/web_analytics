import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { patchRedirectChain } from './redirect-chain-nginx-inject.js';

const LOCATION_RETURN_FIXTURE = `server {
    listen 80;

    location = /old-path/ {
        return 301 /mid-path/;
    }

    location / {
        try_files $uri $uri/ $uri.html =404;
    }
}
`;

const REWRITE_FIXTURE = `server {
    rewrite ^/old-path/?$ /mid-path/ permanent;
}
`;

const AMBIGUOUS_FIXTURE = `server {
    location = /old-path/ {
        return 301 /mid-path/;
    }
    rewrite ^/old-path/?$ /somewhere-else/ permanent;
}
`;

describe('patchRedirectChain — location/return shape', () => {
  test('collapses to the final destination when the live target matches the observed hop', () => {
    const result = patchRedirectChain(LOCATION_RETURN_FIXTURE, '/old-path/', '/mid-path/', '/final-path/');
    assert.equal(result.ok, true);
    assert.match(result.newContent, /return 301 \/final-path\/;/);
    assert.doesNotMatch(result.newContent, /\/mid-path\//);
    assert.match(result.newContent, /listen 80;/);
    assert.match(result.newContent, /try_files \$uri \$uri\/ \$uri\.html =404;/);
  });

  test('refuses when the live target has changed since detection', () => {
    const result = patchRedirectChain(LOCATION_RETURN_FIXTURE, '/old-path/', '/some-other-hop/', '/final-path/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
  });

  test('refuses when the rule already points at the final destination', () => {
    const result = patchRedirectChain(LOCATION_RETURN_FIXTURE, '/old-path/', '/mid-path/', '/mid-path/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-resolved');
  });
});

describe('patchRedirectChain — rewrite shape', () => {
  test('collapses a rewrite directive to the final destination', () => {
    const result = patchRedirectChain(REWRITE_FIXTURE, '/old-path/', '/mid-path/', '/final-path/');
    assert.equal(result.ok, true);
    assert.match(result.newContent, /rewrite \^\/old-path\/\?\$ \/final-path\/ permanent;/);
  });
});

describe('patchRedirectChain — refuses rather than guesses', () => {
  test('no match for a path with no rule at all', () => {
    const result = patchRedirectChain(LOCATION_RETURN_FIXTURE, '/never-configured/', '/mid-path/', '/final-path/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('ambiguous when the same source path is handled by two different rule shapes', () => {
    const result = patchRedirectChain(AMBIGUOUS_FIXTURE, '/old-path/', '/mid-path/', '/final-path/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous-match');
  });
});
