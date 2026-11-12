'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, describe, it } = require('node:test');

const { CacheClient, CacheApiError, cacheKey } = require('../src/lib/objects');

/**
 * Fake Gitera API + bucket on one local server, following the real rules:
 * signed URLs, create-only single PUTs (412 on reuse), multipart parts with
 * ETags, commit checks the stored size, and only committed objects are hits.
 */
class Fake {
  constructor() {
    this.reset();
  }

  reset() {
    this.objects = new Map(); // key -> { status, size, bytes, upload: Map|null, id }
    this.calls = [];
    this.multipartAbove = 1000;
    this.partSize = 400;
    this.firstParts = 2;
    this.failNext = {}; // route -> [status...]
    this.token = 'cache-1';
    this.nextId = 1;
  }

  fail(route, ...statuses) {
    this.failNext[route] = statuses;
  }

  url(pathname) {
    return `${this.base}${pathname}`;
  }

  async handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const route = req.url.startsWith('/bucket/') ? `bucket-${req.method}` : req.url.replace('/api/v1/cache/objects/', '');
    this.calls.push({ route, auth: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'], length: raw.length });
    const queued = this.failNext[route];
    if (queued?.length) {
      const status = queued.shift();
      if (status === 'drop') return req.socket.destroy();
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: `fake_${status}` }));
    }
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    if (route.startsWith('bucket-')) return this.bucket(req, res, raw, send);
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { code: 'invalid_token' });
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const obj = this.objects.get(`${body.tool}/${body.key}`);

    switch (route) {
      case 'lookup': {
        if (body.name !== undefined) {
          // Folder mode: exact name, then the newest committed match of each prefix in order.
          const committed = [...this.objects.entries()].filter(([k, o]) => k.startsWith(`${body.tool}/`) && o.status === 'committed' && o.name);
          let found = committed.find(([, o]) => o.name === body.name);
          let exact = Boolean(found);
          for (const prefix of found ? [] : body.prefixes ?? []) {
            const matches = committed.filter(([, o]) => o.name.startsWith(prefix)).sort((a, b) => b[1].committedAt - a[1].committedAt);
            if (matches.length) {
              found = matches[0];
              exact = false;
              break;
            }
          }
          if (!found) return send(200, { hit: null });
          const [k, o] = found;
          const key = k.slice(body.tool.length + 1);
          return send(200, { hit: { key, name: o.name, exact, url: this.url(`/bucket/${o.id}`), expiresAt: '', sizeBytes: o.size, namespace: 'repo' } });
        }
        const hits = body.keys
          .map((k) => [k, this.objects.get(`${body.tool}/${k}`)])
          .filter(([, o]) => o?.status === 'committed')
          .map(([k, o]) => ({ key: k, url: this.url(`/bucket/${o.id}`), expiresAt: '', sizeBytes: o.size, namespace: 'repo' }));
        return send(200, { hits, misses: body.keys.filter((k) => !hits.some((h) => h.key === k)) });
      }
      case 'uploads': {
        if (obj?.status === 'committed') return send(200, { status: 'exists' });
        if (obj && obj.owner !== 'me') return send(200, { status: 'in_progress' });
        const record = obj ?? { status: 'pending', size: body.sizeBytes, bytes: null, upload: null, id: this.nextId++, owner: 'me' };
        record.size = body.sizeBytes;
        if (body.name !== undefined) {
          if (cacheKey(body.tool, body.name) !== body.key) return send(400, { code: 'invalid_request' });
          record.name = body.name;
        }
        this.objects.set(`${body.tool}/${body.key}`, record);
        if (body.sizeBytes <= this.multipartAbove) {
          return send(200, { status: 'upload', url: this.url(`/bucket/${record.id}`), expiresAt: '', headers: { 'If-None-Match': '*' } });
        }
        record.upload ??= new Map();
        const partCount = Math.ceil(body.sizeBytes / this.partSize);
        const parts = Array.from({ length: Math.min(this.firstParts, partCount) }, (_, i) => this.partUrl(record, i + 1));
        return send(200, { status: 'multipart', partSizeBytes: this.partSize, partCount, parts });
      }
      case 'parts':
        if (!obj?.upload) return send(404, { code: 'upload_not_found' });
        return send(200, { parts: body.partNumbers.map((n) => this.partUrl(obj, n)) });
      case 'commit': {
        if (obj?.status === 'committed') return send(200, { status: 'exists' });
        if (!obj) return send(404, { code: 'upload_not_found' });
        if (obj.upload) {
          const sorted = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
          if (sorted.some((p) => obj.upload.get(p.partNumber)?.etag !== p.etag)) return send(409, { code: 'upload_incomplete' });
          obj.bytes = Buffer.concat(sorted.map((p) => obj.upload.get(p.partNumber).bytes));
        }
        if (!obj.bytes) return send(409, { code: 'upload_missing' });
        if (obj.bytes.length !== obj.size) return send(409, { code: 'size_mismatch' });
        obj.status = 'committed';
        obj.committedAt = this.nextId++;
        return send(200, { status: 'committed' });
      }
      case 'abort':
        this.objects.delete(`${body.tool}/${body.key}`);
        return send(200, { status: 'aborted' });
      default:
        return send(404, { code: 'not_found' });
    }
  }

  partUrl(record, n) {
    return { partNumber: n, url: this.url(`/bucket/${record.id}/part/${n}`), expiresAt: '' };
  }

  bucket(req, res, raw, send) {
    const [, , id, , part] = req.url.split('/');
    const obj = [...this.objects.values()].find((o) => o.id === Number(id));
    if (!obj) return send(404);
    if (req.method === 'GET') {
      this.gets = (this.gets ?? 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (!range) return send(200, obj.bytes);
      const [start, end] = [Number(range[1]), Number(range[2])];
      this.ranges = [...(this.ranges ?? []), [start, end]];
      return send(206, obj.bytes.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${obj.bytes.length}` });
    }
    if (part) {
      const etag = `"${crypto.createHash('md5').update(raw).digest('hex')}"`;
      obj.upload.set(Number(part), { bytes: raw, etag });
      return send(200, undefined, { etag });
    }
    if (req.headers['if-none-match'] !== '*') return send(403);
    if (obj.bytes) return send(412);
    obj.bytes = raw;
    return send(200);
  }
}

const fake = new Fake();
let server;
let dir;

before(async () => {
  server = http.createServer((req, res) => fake.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  fake.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-objects-'));
});

const tokens = () => {
  const t = { refreshed: 0, get: async () => fake.token, refresh: async () => (t.refreshed += 1) };
  return t;
};
const client = (t = tokens()) => new CacheClient(fake.base, t, { sleep: async () => {} });
const file = (size, name = `f-${size}`) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(size));
  return p;
};
const key = (s) => cacheKey('turbo', s);

describe('cacheKey', () => {
  it('is a SHA-256 hex digest that depends on the tool', () => {
    assert.match(cacheKey('turbo', 'abc'), /^[0-9a-f]{64}$/);
    assert.notEqual(cacheKey('turbo', 'abc'), cacheKey('nx', 'abc'));
    assert.equal(cacheKey('turbo', 'abc'), cacheKey('turbo', 'abc'));
  });
});

describe('upload and download', () => {
  it('stores a small file with one create-only PUT and reads it back', async () => {
    const src = file(500);
    assert.equal(await client().upload('turbo', key('a'), src), 'committed');
    const put = fake.calls.find((c) => c.route === 'bucket-PUT');
    assert.equal(put.ifNoneMatch, '*');
    assert.equal(put.length, 500);

    const out = path.join(dir, 'out');
    assert.equal(await client().download('turbo', key('a'), out), 500);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  });

  it('stores a large file in parts, signing the rest just in time', async () => {
    const src = file(2100); // 6 parts of 400, last 100
    assert.equal(await client().upload('turbo', key('b'), src), 'committed');
    assert.equal(fake.calls.filter((c) => c.route === 'bucket-PUT').length, 6);
    assert.ok(fake.calls.some((c) => c.route === 'parts'));
    const out = path.join(dir, 'out');
    await client().download('turbo', key('b'), out);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  });

  it('returns null on a miss without touching the bucket', async () => {
    assert.equal(await client().download('turbo', key('none'), path.join(dir, 'out')), null);
    assert.ok(!fake.calls.some((c) => c.route.startsWith('bucket')));
  });

  it('reports exists and in_progress without uploading', async () => {
    await client().upload('turbo', key('a'), file(10));
    assert.equal(await client().upload('turbo', key('a'), file(10, 'g')), 'exists');
    fake.objects.set(`turbo/${key('c')}`, { status: 'pending', owner: 'other', id: 99 });
    assert.equal(await client().upload('turbo', key('c'), file(10, 'h')), 'in_progress');
  });

  it('looks up more than 100 keys in batches', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => key(`k${i}`));
    await client().upload('turbo', keys[200], file(10));
    const hits = await client().lookup('turbo', keys);
    assert.deepEqual([...hits.keys()], [keys[200]]);
    assert.equal(fake.calls.filter((c) => c.route === 'lookup').length, 3);
  });
});

describe('failures', () => {
  it('retries a 503 from the API and a dropped bucket connection', async () => {
    fake.fail('uploads', 503);
    fake.fail('bucket-PUT', 'drop');
    assert.equal(await client().upload('turbo', key('a'), file(50)), 'committed');
  });

  it('gets fresh URLs when a single PUT is refused (expired)', async () => {
    fake.fail('bucket-PUT', 403);
    assert.equal(await client().upload('turbo', key('a'), file(50)), 'committed');
    assert.equal(fake.calls.filter((c) => c.route === 'uploads').length, 2);
  });

  it('re-signs a part that was refused', async () => {
    fake.fail('bucket-PUT', 403);
    assert.equal(await client().upload('turbo', key('b'), file(1300)), 'committed');
  });

  it('refreshes the token once on a 401', async () => {
    const t = tokens();
    fake.fail('lookup', 401);
    await client(t).lookup('turbo', [key('a')]);
    assert.equal(t.refreshed, 1);
  });

  it('aborts the reservation when an upload cannot finish', async () => {
    fake.fail('commit', 409);
    await assert.rejects(client().upload('turbo', key('a'), file(50)), (error) => {
      assert.ok(error instanceof CacheApiError);
      assert.equal(error.code, 'fake_409');
      return true;
    });
    assert.ok(fake.calls.some((c) => c.route === 'abort'));
    assert.equal(fake.objects.size, 0);
  });

  it('passes an API refusal through with its code, without retrying 507', async () => {
    fake.fail('uploads', 507, 507, 507, 507);
    await assert.rejects(client().upload('turbo', key('a'), file(50)), { code: 'fake_507' });
    assert.equal(fake.calls.filter((c) => c.route === 'uploads').length, 1);
  });

  it('refuses an empty file', async () => {
    await assert.rejects(client().upload('turbo', key('a'), file(0)), { code: 'empty_object' });
  });

  it('turns an unreachable API into a network error', async () => {
    const offline = new CacheClient('http://127.0.0.1:1', tokens(), { sleep: async () => {} });
    await assert.rejects(offline.lookup('turbo', [key('a')]), { code: 'network' });
  });
});

describe('folder mode: named keys', () => {
  const tool = 'folder-0123456789abcdef';

  it('uploads with the readable name and restores it exactly', async () => {
    const src = file(300);
    assert.equal(await client().upload(tool, cacheKey(tool, 'deps-1'), src, { name: 'deps-1' }), 'committed');
    const uploads = fake.calls.filter((c) => c.route === 'uploads');
    assert.ok(uploads.length >= 1);

    const out = path.join(dir, 'out');
    assert.deepEqual(await client().restore(tool, 'deps-1', ['deps-'], out), { name: 'deps-1', exact: true, sizeBytes: 300 });
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  });

  it('falls back to the newest prefix match', async () => {
    await client().upload(tool, cacheKey(tool, 'deps-1'), file(10, 'a'), { name: 'deps-1' });
    await client().upload(tool, cacheKey(tool, 'deps-2'), file(20, 'b'), { name: 'deps-2' });
    const out = path.join(dir, 'out');
    assert.deepEqual(await client().restore(tool, 'deps-3', ['nothing-', 'deps-'], out), { name: 'deps-2', exact: false, sizeBytes: 20 });
  });

  it('returns null on a miss without touching the bucket', async () => {
    assert.equal(await client().restore(tool, 'deps-1', ['deps-'], path.join(dir, 'out')), null);
    assert.ok(!fake.calls.some((c) => c.route.startsWith('bucket')));
  });

  it('signs again when a download fails', async () => {
    await client().upload(tool, cacheKey(tool, 'deps-1'), file(10), { name: 'deps-1' });
    fake.fail('bucket-GET', 403);
    assert.equal((await client().restore(tool, 'deps-1', [], path.join(dir, 'out'))).sizeBytes, 10);
    assert.equal(fake.calls.filter((c) => c.route === 'lookup').length, 2);
  });

  it('a name that does not match the key is refused', async () => {
    await assert.rejects(client().upload(tool, cacheKey(tool, 'a'), file(10), { name: 'b' }), { code: 'invalid_request' });
  });
});

describe('parallel downloads', () => {
  const tool = 'folder-0123456789abcdef';
  const big = (size) => new CacheClient(fake.base, tokens(), { sleep: async () => {}, rangeBytes: 1000 });

  it('downloads a large object in byte ranges and reassembles it exactly', async () => {
    fake.multipartAbove = 1e9; // keep the upload single
    const src = file(4500);
    await big().upload(tool, cacheKey(tool, 'r'), src, { name: 'r' });
    fake.ranges = [];
    const out = path.join(dir, 'out');
    assert.deepEqual(await big().restore(tool, 'r', [], out), { name: 'r', exact: true, sizeBytes: 4500 });
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
    assert.deepEqual(
      fake.ranges.sort((a, b) => a[0] - b[0]),
      [[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4499]]
    );
  });

  it('uses one plain GET for a small object', async () => {
    const src = file(500);
    await big().upload(tool, cacheKey(tool, 's'), src, { name: 's' });
    fake.ranges = [];
    await big().restore(tool, 's', [], path.join(dir, 'out'));
    assert.deepEqual(fake.ranges, []);
  });

  it('signs again when a range fails, and still gets every byte', async () => {
    fake.multipartAbove = 1e9;
    const src = file(3000);
    await big().upload(tool, cacheKey(tool, 'f'), src, { name: 'f' });
    fake.fail('bucket-GET', 403);
    const out = path.join(dir, 'out');
    assert.equal((await big().restore(tool, 'f', [], out)).sizeBytes, 3000);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  });
});

describe('token reuse', () => {
  it('starts from a token handed over by the main step', async () => {
    const { TokenSource } = require('../src/lib/token');
    const reused = new TokenSource('http://127.0.0.1:1', { initial: { token: 'from-main', expiresAt: Date.now() + 30 * 60_000 } });
    assert.equal(await reused.get(), 'from-main');
  });

  it('ignores a handed-over token that is about to expire', async () => {
    const { TokenSource } = require('../src/lib/token');
    const stale = new TokenSource('http://127.0.0.1:1', { initial: { token: 'old', expiresAt: Date.now() + 60_000 }, env: {}, sleep: async () => {} });
    await assert.rejects(stale.get(), { code: 'no_id_token' });
  });
});
