'use strict';

/**
 * Local remote-cache server for build tools, bound to 127.0.0.1.
 *
 *   Turbo   GET|HEAD|PUT /v8/artifacts/:hash, GET /v8/artifacts/status,
 *           POST /v8/artifacts (batch query), POST /v8/artifacts/events
 *   Nx      GET|PUT /v1/cache/:hash   (self-hosted remote cache spec)
 *   Gitera  POST /_gitera/flush  waits for queued uploads, returns stats
 *
 * Requests need `Authorization: Bearer <secret>`, a random value made for
 * this job. Reads stream from the bucket. Writes are buffered to a temp file,
 * answered at once, and uploaded in the background (flushed by the post step).
 *
 * The cache never breaks a build: a failed read is a miss, a failed write is
 * dropped and counted.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { cacheKey } = require('./objects');

const MAX_ARTIFACT_BYTES = 10 * 1024 ** 3;
const UPLOAD_CONCURRENCY = 4;
const HASH = /^[A-Za-z0-9._-]{1,256}$/;

function timingSafeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function newStats() {
  return { hits: 0, misses: 0, uploads: 0, skipped: 0, errors: 0, bytesDown: 0, bytesUp: 0 };
}

/**
 * @param {object} options
 * @param {import('./objects').CacheClient} options.client
 * @param {string} options.secret
 * @param {('turbo'|'nx')[]} options.tools
 * @param {string} [options.tmpDir]
 * @param {(msg: string) => void} [options.log]
 * @param {(url: string) => Promise<import('node:http').IncomingMessage>} [options.openUrl]
 */
function createCacheServer({ client, secret, tools, tmpDir = os.tmpdir(), log = () => {}, openUrl = defaultOpenUrl }) {
  const stats = newStats();
  const queue = [];
  let running = 0;
  let idle = [];
  const work = fs.mkdtempSync(path.join(tmpDir, 'gitera-cache-'));

  const settle = () => {
    if (running === 0 && queue.length === 0) {
      for (const resolve of idle) resolve();
      idle = [];
    }
  };

  const pump = () => {
    while (running < UPLOAD_CONCURRENCY && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      job()
        .catch(() => {})
        .finally(() => {
          running -= 1;
          pump();
          settle();
        });
    }
    settle();
  };

  const enqueueUpload = (tool, hash, file, size) => {
    queue.push(async () => {
      try {
        const result = await client.upload(tool, cacheKey(tool, hash), file);
        if (result === 'committed') {
          stats.uploads += 1;
          stats.bytesUp += size;
        } else {
          stats.skipped += 1;
        }
      } catch (error) {
        stats.errors += 1;
        log(`upload ${tool} ${hash} failed: ${error.code ?? ''} ${error.message}`);
      } finally {
        fs.rm(file, { force: true }, () => {});
      }
    });
    pump();
  };

  const flush = () => (running === 0 && queue.length === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve)));

  async function read(tool, hash, req, res) {
    let hit;
    try {
      hit = (await client.lookup(tool, [cacheKey(tool, hash)])).get(cacheKey(tool, hash));
    } catch (error) {
      stats.errors += 1;
      log(`lookup ${tool} ${hash} failed: ${error.code ?? ''} ${error.message}`);
    }
    if (!hit) {
      stats.misses += 1;
      return end(res, 404);
    }
    if (req.method === 'HEAD') {
      stats.hits += 1;
      res.writeHead(200, { 'Content-Length': String(hit.sizeBytes) });
      return res.end();
    }
    let upstream;
    try {
      upstream = await openUrl(hit.url);
    } catch (error) {
      stats.errors += 1;
      stats.misses += 1;
      log(`download ${tool} ${hash} failed: ${error.message}`);
      return end(res, 404);
    }
    if (upstream.statusCode !== 200) {
      upstream.resume();
      stats.misses += 1;
      return end(res, 404);
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(hit.sizeBytes) });
    try {
      await pipeline(upstream, res);
      stats.hits += 1;
      stats.bytesDown += hit.sizeBytes;
    } catch (error) {
      // Headers are out; the tool sees a short body and treats it as a failed read.
      stats.errors += 1;
      log(`download ${tool} ${hash} broke off: ${error.message}`);
    }
  }

  async function write(tool, hash, req, res, okStatus) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
      req.resume();
      stats.skipped += 1;
      return end(res, okStatus);
    }
    const file = path.join(work, `${tool}-${crypto.randomUUID()}`);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
    });
    try {
      await pipeline(req, fs.createWriteStream(file));
    } catch (error) {
      stats.errors += 1;
      fs.rm(file, { force: true }, () => {});
      log(`receiving ${tool} ${hash} failed: ${error.message}`);
      return end(res, okStatus);
    }
    end(res, okStatus);
    if (size === 0 || size > MAX_ARTIFACT_BYTES) {
      stats.skipped += 1;
      return fs.rm(file, { force: true }, () => {});
    }
    enqueueUpload(tool, hash, file, size);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !timingSafeEqual(auth.slice(7), secret)) {
        req.resume();
        return end(res, 401, 'Invalid Gitera cache token');
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);

      if (url.pathname === '/_gitera/flush' && req.method === 'POST') {
        await flush();
        return json(res, 200, stats);
      }

      if (tools.includes('turbo') && parts[0] === 'v8' && parts[1] === 'artifacts') {
        if (parts.length === 3 && parts[2] === 'status') return json(res, 200, { status: 'enabled' });
        if (parts.length === 3 && parts[2] === 'events') return drain(req, res, 200);
        if (parts.length === 2 && req.method === 'POST') return batchQuery(req, res);
        const hash = parts[2];
        if (parts.length !== 3 || !HASH.test(hash)) return drain(req, res, 400);
        if (req.method === 'GET' || req.method === 'HEAD') return await read('turbo', hash, req, res);
        if (req.method === 'PUT') return await write('turbo', hash, req, res, 202);
        return drain(req, res, 405);
      }

      if (tools.includes('nx') && parts[0] === 'v1' && parts[1] === 'cache' && parts.length === 3) {
        const hash = parts[2];
        if (!HASH.test(hash)) return drain(req, res, 400);
        if (req.method === 'GET') return await read('nx', hash, req, res);
        if (req.method === 'PUT') return await write('nx', hash, req, res, 200);
        return drain(req, res, 405);
      }

      return drain(req, res, 404);
    } catch (error) {
      stats.errors += 1;
      log(`request failed: ${error.message}`);
      if (!res.headersSent) end(res, 404);
      else res.destroy();
    }
  });

  /** Turbo's POST /v8/artifacts { hashes } answers which hashes exist. */
  async function batchQuery(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let hashes = [];
    try {
      hashes = (JSON.parse(Buffer.concat(chunks).toString('utf8')).hashes ?? []).filter((h) => HASH.test(h));
    } catch {
      return end(res, 400);
    }
    const answer = Object.fromEntries(hashes.map((h) => [h, null]));
    try {
      const found = await client.lookup('turbo', hashes.map((h) => cacheKey('turbo', h)));
      for (const h of hashes) {
        const hit = found.get(cacheKey('turbo', h));
        if (hit) answer[h] = { size: hit.sizeBytes, taskDurationMs: 0 };
      }
    } catch (error) {
      stats.errors += 1;
      log(`batch query failed: ${error.message}`);
    }
    return json(res, 200, answer);
  }

  server.on('close', () => fs.rm(work, { recursive: true, force: true }, () => {}));
  return { server, stats, flush };
}

function end(res, status, message = '') {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(message);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function drain(req, res, status) {
  req.resume();
  req.on('end', () => end(res, status));
}

function defaultOpenUrl(signedUrl) {
  const url = new URL(signedUrl);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: 10 * 60 * 1000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

module.exports = { createCacheServer, MAX_ARTIFACT_BYTES };
