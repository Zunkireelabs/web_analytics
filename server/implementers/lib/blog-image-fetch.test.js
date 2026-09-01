import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchImageAsset, resolveBlogImageCommit } from './blog-image-fetch.js';

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200, 1)]);
const HTML_ERROR_PAGE = Buffer.from('<html><body>404 not found</body></html>'.repeat(5));

function fakeResponse({ ok = true, body, headers = {} } = {}) {
  return {
    ok,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('fetchImageAsset', () => {
  afterEach(() => mock.restoreAll());

  test('accepts real JPEG bytes', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: JPEG_BYTES }));
    const result = await fetchImageAsset('https://images.pexels.com/photos/1/x.jpeg');
    assert.equal(result.ext, '.jpg');
    assert.ok(Buffer.isBuffer(result.buffer));
  });

  test('accepts real PNG bytes', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: PNG_BYTES }));
    const result = await fetchImageAsset('https://example.com/x.png');
    assert.equal(result.ext, '.png');
  });

  test('accepts real WEBP bytes', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: WEBP_BYTES }));
    const result = await fetchImageAsset('https://example.com/x.webp');
    assert.equal(result.ext, '.webp');
  });

  test('rejects a non-image body even with a 200 status (an HTML error page)', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: HTML_ERROR_PAGE }));
    const result = await fetchImageAsset('https://example.com/x.jpeg');
    assert.equal(result, null);
  });

  test('rejects an empty/near-empty body', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: Buffer.from([0xff, 0xd8]) }));
    const result = await fetchImageAsset('https://example.com/x.jpeg');
    assert.equal(result, null);
  });

  test('rejects a body over the size cap via Content-Length', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ body: JPEG_BYTES, headers: { 'content-length': String(50 * 1024 * 1024) } }));
    const result = await fetchImageAsset('https://example.com/x.jpeg');
    assert.equal(result, null);
  });

  test('a non-ok HTTP response returns null, not a throw', async () => {
    mock.method(global, 'fetch', async () => fakeResponse({ ok: false, body: Buffer.alloc(0) }));
    const result = await fetchImageAsset('https://example.com/x.jpeg');
    assert.equal(result, null);
  });

  test('a network failure returns null, not a throw', async () => {
    mock.method(global, 'fetch', async () => { throw new Error('network down'); });
    const result = await fetchImageAsset('https://example.com/x.jpeg');
    assert.equal(result, null);
  });

  test('no url at all returns null', async () => {
    assert.equal(await fetchImageAsset(null), null);
    assert.equal(await fetchImageAsset(''), null);
  });
});

describe('resolveBlogImageCommit', () => {
  afterEach(() => mock.restoreAll());

  test('nothing to place when there is no repo path or no source url', async () => {
    const readFile = mock.fn(async () => null);
    assert.deepEqual(await resolveBlogImageCommit({}, 'main', null, 'https://x/y.jpeg', readFile), { file: null, imageFailed: false });
    assert.deepEqual(await resolveBlogImageCommit({}, 'main', 'images/blog/a.jpeg', null, readFile), { file: null, imageFailed: false });
    assert.equal(readFile.mock.callCount(), 0, 'never even checks the repo when there is nothing to resolve');
  });

  test('already present on the branch -> no download, no duplicate file (retry/rerun dedup)', async () => {
    const readFile = mock.fn(async () => ({ content: 'binary-ish', sha: 'abc' }));
    mock.method(global, 'fetch', () => { throw new Error('should never be called'); });
    const result = await resolveBlogImageCommit({}, 'main', 'images/blog/a.jpeg', 'https://images.pexels.com/photos/1/x.jpeg', readFile);
    assert.deepEqual(result, { file: null, imageFailed: false });
  });

  test('not present -> downloads and returns a contentBuffer file entry', async () => {
    const readFile = mock.fn(async () => null);
    mock.method(global, 'fetch', async () => fakeResponse({ body: JPEG_BYTES }));
    const result = await resolveBlogImageCommit({}, 'main', 'images/blog/a.jpeg', 'https://images.pexels.com/photos/1/x.jpeg', readFile);
    assert.equal(result.imageFailed, false);
    assert.equal(result.file.path, 'images/blog/a.jpeg');
    assert.ok(Buffer.isBuffer(result.file.contentBuffer));
  });

  test('not present and download fails -> imageFailed, no file', async () => {
    const readFile = mock.fn(async () => null);
    mock.method(global, 'fetch', async () => fakeResponse({ ok: false, body: Buffer.alloc(0) }));
    const result = await resolveBlogImageCommit({}, 'main', 'images/blog/a.jpeg', 'https://images.pexels.com/photos/1/x.jpeg', readFile);
    assert.deepEqual(result, { file: null, imageFailed: true });
  });
});
