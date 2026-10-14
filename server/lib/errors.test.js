import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// logInternal persists every ref it hands out (server/migrations/164) so a
// customer-facing "ref: <id>" is still resolvable after container logs
// rotate — confirmed dead end otherwise: Chayce Properties draft #1741's
// "ref: b6cfde8a" was unrecoverable 13 days later. Captures each INSERT INTO
// internal_errors call this suite makes so the persistence itself is
// verified, not just the pre-existing console.error/return-id behavior.
const insertedErrors = [];
mock.module(resolve('../db.js'), {
  namedExports: {
    query: (text, params) => {
      if (text.includes('INSERT INTO internal_errors')) {
        insertedErrors.push({ id: params[0], context: params[1], message: params[2], stack: params[3], causeMessage: params[4], causeStack: params[5] });
      }
      return { rows: [] };
    },
  },
});

const { UserFacingError, sanitizeForCustomer, sanitizeDeep, safeMessage, logInternal, __resetInternalErrorDedupe, describeFetchFailure, describeHttpFailure } = await import('./errors.js');

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

  test('blocks a bare built-in error message with no "TypeError:" prefix — the shape a real Error.message actually has', () => {
    // Regression, confirmed live 2026-09-09: err.message NEVER carries the
    // class-name prefix (only err.stack/err.toString() do), so the
    // TypeError:/ReferenceError:/etc. pattern above never matches the single
    // most common shape of an uncaught internal crash reaching this
    // boundary. This exact string reached an Action Center card verbatim.
    assert.equal(sanitizeForCustomer("Cannot read properties of null (reading 'id')"), null);
    assert.equal(sanitizeForCustomer("Cannot read property 'id' of undefined"), null);
    assert.equal(sanitizeForCustomer('doThing is not a function'), null);
    assert.equal(sanitizeForCustomer('foo is not defined'), null);
    assert.equal(sanitizeForCustomer('items is not iterable'), null);
    assert.equal(sanitizeForCustomer('Assignment to constant variable.'), null);
    assert.equal(sanitizeForCustomer('Maximum call stack size exceeded'), null);
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

  test('logInternal persists the ref so it is still resolvable after logs rotate', async () => {
    const original = console.error;
    console.error = () => {};
    insertedErrors.length = 0;
    try {
      const wrapped = new UserFacingError('Generic customer-safe message.', {
        cause: new Error('the real underlying detail'),
      });
      const id = logInternal('github-ops.openPrForBranch', wrapped);
      // The insert is fire-and-forget (never awaited by logInternal itself),
      // so give its microtask a tick to run before asserting on it.
      await new Promise((r) => setImmediate(r));
      assert.equal(insertedErrors.length, 1);
      assert.equal(insertedErrors[0].id, id);
      assert.equal(insertedErrors[0].context, 'github-ops.openPrForBranch');
      assert.equal(insertedErrors[0].causeMessage, 'the real underlying detail');
    } finally {
      console.error = original;
    }
  });

  // Real incident: one token-permission 403 from getCheckRunsForRef wrote
  // 44,121 identical rows (45MB of a 57MB table) in six days. Only a STORM is
  // capped — ordinary failures must keep distinct, individually resolvable refs
  // (github-ops.test.js depends on that).
  describe('storm suppression', () => {
    const quiet = async (fn) => {
      const original = console.error;
      console.error = () => {};
      try { return await fn(); } finally { console.error = original; }
    };
    // Same call site every time: a real storm repeats from one place. (A loop
    // inside one test body has one stack, exactly like a polling loop does.)
    const boom = (msg = '403 Resource not accessible') => new Error(msg);
    const raise = (ctx, mk) => logInternal(ctx, mk());

    test('ordinary repeats are each recorded with their own distinct ref', async () => {
      __resetInternalErrorDedupe();
      insertedErrors.length = 0;
      const ids = await quiet(async () => {
        const out = [raise('ctx-o', () => boom('x')), raise('ctx-o', () => boom('x')), raise('ctx-o', () => boom('x'))];
        await new Promise((r) => setImmediate(r));
        return out;
      });
      assert.equal(insertedErrors.length, 3);
      assert.equal(new Set(ids).size, 3, 'three failures, three distinct refs');
    });

    test('a storm is capped: beyond 3 per window it reuses the latest recorded ref and writes nothing', async () => {
      __resetInternalErrorDedupe();
      insertedErrors.length = 0;
      const ids = await quiet(async () => {
        const out = [];
        for (let i = 0; i < 50; i++) out.push(raise('github.getCheckRunsForRef', () => boom()));
        await new Promise((r) => setImmediate(r));
        return out;
      });
      assert.equal(insertedErrors.length, 3, 'fifty identical failures must write three rows');
      assert.equal(new Set(ids).size, 3);
      assert.equal(ids[49], ids[2], 'every suppressed repeat hands back the last recorded ref');
      assert.equal(insertedErrors.at(-1).id, ids[49], 'and that ref is a row that was actually persisted');
    });

    test('a different message, context, or underlying cause is never merged into a storm', async () => {
      __resetInternalErrorDedupe();
      insertedErrors.length = 0;
      await quiet(async () => {
        for (let i = 0; i < 5; i++) raise('ctx-a', () => boom('boom'));          // storm of one error
        raise('ctx-b', () => boom('boom'));                                      // other context
        raise('ctx-a', () => boom('different'));                                 // other message
        for (let i = 0; i < 4; i++) {
          logInternal('ctx-a', new UserFacingError('Generic.', { cause: new Error('docker down') }));
        }
        logInternal('ctx-a', new UserFacingError('Generic.', { cause: new Error('llm auth failed') }));
        await new Promise((r) => setImmediate(r));
      });
      // 3 (storm capped) + 1 + 1 + 3 (docker storm capped) + 1 (distinct cause) = 9
      assert.equal(insertedErrors.length, 9);
      assert.ok(insertedErrors.some((e) => e.causeMessage === 'llm auth failed'), 'the distinct underlying cause was recorded');
    });

    test('after the window it records again, so a still-broken integration stays visible', async () => {
      __resetInternalErrorDedupe();
      insertedErrors.length = 0;
      const realNow = Date.now;
      let t = 1_000_000;
      Date.now = () => t;
      try {
        await quiet(async () => {
          for (let i = 0; i < 6; i++) raise('ctx-w', () => boom('still failing')); // capped at 3
          t += 11 * 60 * 1000;
          raise('ctx-w', () => boom('still failing'));                           // new window: recorded
          await new Promise((r) => setImmediate(r));
        });
      } finally {
        Date.now = realNow;
      }
      assert.equal(insertedErrors.length, 4);
    });

    test('suppressed repeats still reach the console, marked as a storm', () => {
      __resetInternalErrorDedupe();
      const original = console.error;
      const logged = [];
      console.error = (...args) => { logged.push(args.join(' ')); };
      try {
        for (let i = 0; i < 5; i++) raise('ctx-c', () => boom('flaky'));
        assert.equal(logged.length, 5);
        assert.match(logged[4], /repeat storm, not re-recorded/);
      } finally {
        console.error = original;
      }
    });
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
