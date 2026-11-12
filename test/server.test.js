'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');

const { createCacheServer } = require('../src/lib/server');
const { cacheKey } = require('../src/lib/objects');
const { startServer, stopServer } = require('../src/lib/daemon');

const SECRET = 'local-secret';

/** In-memory stand-in for CacheClient; "bucket" bytes are served by a local server. */
class FakeClient {
  constructor() {
    this.stored = new Map(); // apiKey -> Buffer
    this.failLookup = false;
    this.failUpload = false;
    this.lookups = [];
  }
  async lookup(tool, keys) {
    this.lookups.push({ tool, keys });
    if (this.failLookup) throw Object.assign(new Error('api down'), { code: 'network' });
    const hits = new Map();
    for (const k of keys) if (this.stored.has(k)) hits.set(k, { key: k, url: `${bucketBase}/${k}`, sizeBytes: this.stored.get(k).length });
    return hits;
  }
  async upload(tool, key, file) {
    await new Promise((r) => setTimeout(r, 20));
    if (this.failUpload) throw Object.assign(new Error('r2 down'), { code: 'network' });
    if (this.stored.has(key)) return 'exists';
    this.stored.set(key, fs.readFileSync(file));
    return 'committed';
  }
}

let bucket;
let bucketBase;
let client;
let cache;
let base;

before(async () => {
  bucket = http.createServer((req, res) => {
    const data = client.stored.get(req.url.slice(1));
    if (!data) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': data.length }).end(data);
  });
  await new Promise((r) => bucket.listen(0, '127.0.0.1', r));
  bucketBase = `http://127.0.0.1:${bucket.address().port}`;
});
after(() => bucket.close());

beforeEach(async () => {
  client = new FakeClient();
  cache = createCacheServer({ client, secret: SECRET, tools: ['turbo', 'nx'] });
  await new Promise((r) => cache.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${cache.server.address().port}`;
});
afterEach(() => new Promise((r) => cache.server.close(r)));

const req = (method, p, { body, token = SECRET } = {}) =>
  fetch(`${base}${p}`, { method, body, headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('turbo protocol', () => {
  it('stores on PUT and serves the same bytes on GET and HEAD', async () => {
    const bytes = Buffer.from('turbo artifact bytes');
    assert.equal((await req('PUT', '/v8/artifacts/abc123?teamId=gitera', { body: bytes })).status, 202);
    await cache.flush();
    assert.deepEqual(client.stored.get(cacheKey('turbo', 'abc123')), bytes);

    const got = await req('GET', '/v8/artifacts/abc123?teamId=gitera');
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.equal((await req('HEAD', '/v8/artifacts/abc123')).status, 200);
    assert.deepEqual(cache.stats, { hits: 2, misses: 0, uploads: 1, skipped: 0, errors: 0, bytesDown: bytes.length, bytesUp: bytes.length });
  });

  it('answers a miss with 404', async () => {
    assert.equal((await req('GET', '/v8/artifacts/nope')).status, 404);
    assert.equal(cache.stats.misses, 1);
  });

  it('reports status and accepts events', async () => {
    assert.deepEqual(await (await req('GET', '/v8/artifacts/status')).json(), { status: 'enabled' });
    assert.equal((await req('POST', '/v8/artifacts/events', { body: '[]' })).status, 200);
  });

  it('answers a batch query', async () => {
    client.stored.set(cacheKey('turbo', 'have'), Buffer.from('xx'));
    const res = await req('POST', '/v8/artifacts', { body: JSON.stringify({ hashes: ['have', 'nope'] }) });
    assert.deepEqual(await res.json(), { have: { size: 2, taskDurationMs: 0 }, nope: null });
  });
});

describe('nx protocol', () => {
  it('stores on PUT (200) and serves GET', async () => {
    assert.equal((await req('PUT', '/v1/cache/9182736455', { body: 'nx tar' })).status, 200);
    await cache.flush();
    const got = await req('GET', '/v1/cache/9182736455');
    assert.equal(await got.text(), 'nx tar');
  });

  it('keeps turbo and nx keys apart', async () => {
    await req('PUT', '/v1/cache/same', { body: 'nx' });
    await cache.flush();
    assert.equal((await req('GET', '/v8/artifacts/same')).status, 404);
  });
});

describe('safety', () => {
  it('refuses a missing or wrong secret', async () => {
    assert.equal((await req('GET', '/v8/artifacts/abc', { token: null })).status, 401);
    assert.equal((await req('GET', '/v8/artifacts/abc', { token: 'wrong' })).status, 401);
    assert.equal(client.lookups.length, 0);
  });

  it('refuses odd hashes and unknown paths', async () => {
    assert.equal((await req('GET', '/v8/artifacts/..%2Fetc')).status, 400);
    assert.equal((await req('GET', '/v2/whatever')).status, 404);
  });

  it('only serves the tools it was started for', async () => {
    const only = createCacheServer({ client, secret: SECRET, tools: ['nx'] });
    await new Promise((r) => only.server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${only.server.address().port}/v8/artifacts/status`, { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(res.status, 404);
    await new Promise((r) => only.server.close(r));
  });
});

describe('never breaks the build', () => {
  it('turns a failed lookup into a miss', async () => {
    client.failLookup = true;
    assert.equal((await req('GET', '/v8/artifacts/abc')).status, 404);
    assert.equal(cache.stats.errors, 1);
  });

  it('accepts a write even when the upload later fails', async () => {
    client.failUpload = true;
    assert.equal((await req('PUT', '/v8/artifacts/abc', { body: 'x' })).status, 202);
    await cache.flush();
    assert.equal(cache.stats.errors, 1);
    assert.equal(cache.stats.uploads, 0);
  });

  it('counts an existing object as skipped', async () => {
    await req('PUT', '/v8/artifacts/abc', { body: 'x' });
    await req('PUT', '/v8/artifacts/abc', { body: 'x' });
    await cache.flush();
    assert.equal(cache.stats.uploads, 1);
    assert.equal(cache.stats.skipped, 1);
  });

  it('flush waits for every queued upload', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => req('PUT', `/v8/artifacts/h${i}`, { body: `b${i}` })));
    const res = await req('POST', '/_gitera/flush');
    assert.equal((await res.json()).uploads, 10);
  });
});

describe('background process', () => {
  it('starts detached, serves a miss when Gitera is unreachable, and stops with stats', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-daemon-'));
    const server = await startServer({ apiUrl: 'http://127.0.0.1:1', tools: ['turbo'], dir });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v8/artifacts/abc`, { headers: { Authorization: `Bearer ${server.secret}` } });
      assert.equal(res.status, 404);
      assert.ok(!fs.readFileSync(server.logFile, 'utf8').includes(server.secret));
    } finally {
      const stats = await stopServer(server);
      assert.equal(stats.misses, 1);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
