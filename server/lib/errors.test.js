import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserFacingError, sanitizeForCustomer, sanitizeDeep, safeMessage, logInternal, describeFetchFailure, describeHttpFailure } from './errors.js';

describe('UserFacingError', () => {
  test('is a real Error with userFacing marker', () => {
    const err = new UserFacingError('Site not configured yet.');
    assert.ok(err instanceof Error);
    assert.equal(err.userFacing, true);
    assert.equal(err.message, 'Site not configured yet.');
    assert.equal(err.status, 400);
  });

  test('accepts a custom status and code', () => {
    const err = new UserFacingError('Not found.', { status: 404, code: 'not-found' });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not-found');
  });
});

describe('sanitizeForCustomer', () => {
  test('blocks HTTP status patterns', () => {
    assert.equal(sanitizeForCustomer('createBranch failed (403): Resource not accessible'), null);
    assert.equal(sanitizeForCustomer('Google Custom Search request failed: HTTP 429'), null);
  });

  test('blocks raw network exception names', () => {
    assert.equal(sanitizeForCustomer('fetch failed: ECONNREFUSED 127.0.0.1:443'), null);
    assert.equal(sanitizeForCustomer('getaddrinfo ENOTFOUND example.invalid'), null);
  });

  test('blocks stack trace frames', () => {
    assert.equal(sanitizeForCustomer('TypeError: x is not a function\n    at Object.<anonymous> (/app/server/foo.js:12:5)'), null);
  });

  test('blocks provider-name-plus-failure phrasing', () => {
    assert.equal(sanitizeForCustomer('OpenAI request failed after 3 retries'), null);
  });

  test('leaves genuinely safe, developer-authored text untouched', () => {
    const safe = 'This page could not be checked right now — showing results based on other signals.';
    assert.equal(sanitizeForCustomer(safe), safe);
  });

  test('returns a custom fallback when provided', () => {
    assert.equal(sanitizeForCustomer('HTTP 500', 'Something needs another look.'), 'Something needs another look.');
  });

  test('passes through non-strings untouched', () => {
    assert.equal(sanitizeForCustomer(null), null);
    assert.equal(sanitizeForCustomer(undefined), undefined);
    assert.equal(sanitizeForCustomer(42), 42);
  });
});

describe('sanitizeDeep', () => {
  test('redacts unsafe strings anywhere in a nested structure', () => {
    const input = {
      summary: 'Looks fine',
      evidence: { detail: 'request failed (502): upstream timeout', ok: true },
      list: ['fine', 'ECONNRESET while fetching'],
    };
    const out = sanitizeDeep(input);
    assert.equal(out.summary, 'Looks fine');
    assert.equal(out.evidence.detail, null);
    assert.equal(out.evidence.ok, true);
    assert.deepEqual(out.list, ['fine', null]);
  });
});

describe('safeMessage / logInternal', () => {
  test('returns the fallback message and a correlation id, without throwing', () => {
    const original = console.error;
    let logged = '';
    console.error = (...args) => { logged = args.join(' '); };
    try {
      const { message, id } = safeMessage('test.context', new Error('raw db error: connection refused'), 'This step is temporarily unavailable.');
      assert.equal(message, 'This step is temporarily unavailable.');
      assert.match(id, /^[a-f0-9]{8}$/);
      assert.match(logged, /test\.context/);
      assert.match(logged, /raw db error/);
    } finally {
      console.error = original;
    }
  });

  test('logInternal returns a correlation id', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const id = logInternal('ctx', new Error('x'));
      assert.match(id, /^[a-f0-9]{8}$/);
    } finally {
      console.error = original;
    }
  });

  test('logInternal also prints err.cause — the real detail behind a wrapped UserFacingError', () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      const wrapped = new UserFacingError('Generic customer-safe message.', {
        cause: new Error('OpenHands detail: Docker daemon unreachable at /var/run/docker.sock'),
      });
      logInternal('design-agent.worker.processOneJob', wrapped);
      assert.ok(
        logged.some((line) => line.includes('Docker daemon unreachable')),
        'the cause must reach the developer-facing log, not just the generic wrapper message'
      );
    } finally {
      console.error = original;
    }
  });

  test('logInternal does not throw or print an extra line when there is no cause', () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      logInternal('ctx', new Error('plain error, no cause'));
      assert.equal(logged.length, 1);
    } finally {
      console.error = original;
    }
  });
});

describe('describeFetchFailure', () => {
  test('categorizes an AbortError as timeout', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      assert.equal(describeFetchFailure('ctx', err), 'timeout');
    } finally { console.error = original; }
  });

  test('categorizes any other exception as a generic network error, never the raw message', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const result = describeFetchFailure('ctx', new Error('connect ECONNREFUSED 10.0.0.5:443'));
      assert.equal(result, 'network error');
      assert.doesNotMatch(result, /ECONNREFUSED|10\.0\.0\.5/);
    } finally { console.error = original; }
  });
});

describe('describeHttpFailure', () => {
  test('maps known statuses to safe categories, never the number itself', () => {
    assert.equal(describeHttpFailure(404), 'not found');
    assert.equal(describeHttpFailure(401), 'access denied');
    assert.equal(describeHttpFailure(403), 'access denied');
    assert.equal(describeHttpFailure(503), 'server error');
    assert.equal(describeHttpFailure(429), 'request failed');
  });
});
