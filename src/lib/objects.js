'use strict';

/**
 * Client for the Gitera object API (POST <api-url>/api/v1/cache/objects/*).
 *
 * The API only signs URLs; bytes go straight between the runner and the
 * bucket. Keys sent to the API are SHA-256 hex digests of the caller's key
 * (a Turbo hash, an Nx hash, or a folder cache key), built by `cacheKey`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const { withRetry, NetworkError, defaultSleep } = require('./retry');
const { putFile, getToFile, getRangeToFile } = require('./transfer');

const MAX_LOOKUP_KEYS = 100;
const PART_CONCURRENCY = 4;
/**
 * Objects above this are downloaded as parallel byte ranges of this size.
 * Small ranges let an unpack follow the download closely: 8 at a time of
 * 4 MiB keeps it at most about 32 MiB behind.
 */
const RANGE_BYTES = 4 * 1024 * 1024;
const RANGE_CONCURRENCY = 8;
const URL_REFRESH_MS = 45 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const FOLLOW_CHUNK = 1024 * 1024;

/**
 * Reads a file that is still being written, up to the `ready` offset, and
 * waits for `advance()` to move it. Ends at `size`.
 */
class FileFollower extends Readable {
  constructor(filePath, size) {
    super({ highWaterMark: FOLLOW_CHUNK });
    this.fd = fs.openSync(filePath, 'r');
    this.size = size;
    this.pos = 0;
    this.ready = 0;
    this.waiting = false;
  }

  advance(ready) {
    this.ready = ready;
    if (this.waiting) {
      this.waiting = false;
      this._read();
    }
  }

  _read() {
    if (this.pos >= this.size) return this.push(null);
    if (this.pos >= this.ready) {
      this.waiting = true;
      return undefined;
    }
    const length = Math.min(FOLLOW_CHUNK, this.ready - this.pos);
    const buffer = Buffer.allocUnsafe(length);
    fs.read(this.fd, buffer, 0, length, this.pos, (error, bytes) => {
      if (error) return this.destroy(error);
      this.pos += bytes;
      return this.push(buffer.subarray(0, bytes));
    });
    return undefined;
  }

  _destroy(error, callback) {
    fs.close(this.fd, () => callback(error));
  }
}

class CacheApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** SHA-256 hex of a caller key, namespaced by tool so tools never collide. */
function cacheKey(tool, key) {
  return crypto.createHash('sha256').update(`${tool}\0${key}`).digest('hex');
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

class CacheClient {
  /**
   * @param {string} apiUrl  Gitera origin
   * @param {{ get(): Promise<string>, refresh(): Promise<unknown> }} tokens
   */
  constructor(
    apiUrl,
    tokens,
    { fetch = globalThis.fetch, sleep = defaultSleep, transfer = { putFile, getToFile, getRangeToFile }, rangeBytes = RANGE_BYTES } = {}
  ) {
    this.apiUrl = apiUrl;
    this.tokens = tokens;
    this.fetch = fetch;
    this.sleep = sleep;
    this.transfer = transfer;
    this.rangeBytes = rangeBytes;
  }

  /** One API call: retries temporary failures, and a 401 once with a fresh token. */
  async call(action, body) {
    for (let auth = 0; auth < 2; auth += 1) {
      const token = await this.tokens.get();
      let response;
      try {
        response = await withRetry(
          `Gitera ${action}`,
          () =>
            this.fetch(`${this.apiUrl}/api/v1/cache/objects/${action}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }),
          { sleep: this.sleep }
        );
      } catch (error) {
        if (error instanceof NetworkError) throw new CacheApiError(error.message, 'network');
        throw error;
      }
      const json = await readJson(response);
      if (response.ok) return json;
      const code = typeof json?.code === 'string' ? json.code : `http_${response.status}`;
      if (response.status === 401 && auth === 0) {
        await this.tokens.refresh();
        continue;
      }
      throw new CacheApiError(typeof json?.error === 'string' ? json.error : `Gitera answered ${response.status}`, code, response.status);
    }
    throw new CacheApiError('Gitera refused the cache token', 'invalid_token', 401);
  }

  /** Looks up keys (any number; sent in batches of 100). Returns a Map of key -> hit. */
  async lookup(tool, keys) {
    const hits = new Map();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += MAX_LOOKUP_KEYS) {
      const result = await this.call('lookup', { tool, keys: unique.slice(i, i + MAX_LOOKUP_KEYS) });
      for (const hit of result?.hits ?? []) hits.set(hit.key, hit);
    }
    return hits;
  }

  /**
   * Downloads one object into `filePath`. Returns its size, or null on a miss.
   * A URL that expired or failed is signed again with a new lookup.
   */
  async download(tool, key, filePath) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const hit = (await this.lookup(tool, [key])).get(key);
      if (!hit) return null;
      let result;
      try {
        result = await withRetry('Bucket download', () => this.transfer.getToFile(hit.url, filePath), { sleep: this.sleep });
      } catch (error) {
        if (attempt === 3) throw new CacheApiError(error.message, 'network');
        continue;
      }
      if (result.status === 200 && result.bytes === hit.sizeBytes) return hit.sizeBytes;
      if (result.status === 404) return null;
      if (attempt === 3) {
        throw new CacheApiError(`Bucket download answered ${result.status} (${result.bytes} of ${hit.sizeBytes} bytes)`, 'download_failed', result.status);
      }
    }
    return null;
  }

  /**
   * Folder mode, like actions/cache: restores the exact `name`, else the newest
   * match of the first prefix that matches, into `filePath`. Returns
   * `{ name, exact, sizeBytes }`, or null on a miss. A failed or expired URL
   * gets a new lookup.
   *
   * With `extract(readable)`, the archive is also handed to it in order while
   * it downloads, so unpacking overlaps the download. A failed download stops
   * that unpack and the next attempt unpacks again from the start. A failed
   * unpack is thrown at once, without another download.
   */
  async restore(tool, name, prefixes, filePath, { extract } = {}) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const hit = (await this.call('lookup', { tool, name, prefixes }))?.hit;
      if (!hit) return null;
      const size = await this.fetchHit(hit, filePath, attempt === 3, extract);
      if (size !== null) return { name: hit.name, exact: hit.exact, sizeBytes: size };
    }
    return null;
  }

  /** One download attempt. Returns the size, or null to try again; throws on the last attempt. */
  async fetchHit(hit, filePath, last, extract) {
    if (hit.sizeBytes > this.rangeBytes) return this.fetchRanges(hit, filePath, last, extract);
    let result;
    try {
      result = await withRetry('Bucket download', () => this.transfer.getToFile(hit.url, filePath), { sleep: this.sleep });
    } catch (error) {
      if (last) throw new CacheApiError(error.message, 'network');
      return null;
    }
    if (result.status === 200 && result.bytes === hit.sizeBytes) {
      if (extract) await extract(fs.createReadStream(filePath));
      return hit.sizeBytes;
    }
    if (last) {
      throw new CacheApiError(`Bucket download answered ${result.status} (${result.bytes} of ${hit.sizeBytes} bytes)`, 'download_failed', result.status);
    }
    return null;
  }

  /**
   * Downloads a large object as byte ranges, up to RANGE_CONCURRENCY at once,
   * each written at its own offset. Ranges are taken in order, and `extract`
   * (if given) reads the file up to the end of the first range not yet done.
   * Any range that fails makes the whole attempt return null, so the caller
   * signs a fresh URL and tries again.
   */
  async fetchRanges(hit, filePath, last, extract) {
    const size = hit.sizeBytes;
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, size);
    const ranges = [];
    for (let start = 0; start < size; start += this.rangeBytes) ranges.push([start, Math.min(size, start + this.rangeBytes) - 1]);

    const done = new Array(ranges.length).fill(false);
    let ready = 0; // ranges[0..ready) are all on disk
    const follower = extract ? new FileFollower(filePath, size) : null;
    // The unpack reports its own errors; this keeps a late one from crashing the step.
    follower?.on('error', () => {});
    let unpackError = null;
    const unpacking = follower
      ? Promise.resolve()
          .then(() => extract(follower))
          .catch((error) => {
            unpackError = error;
          })
      : null;

    let failure = null;
    let next = 0;
    const worker = async () => {
      while (next < ranges.length && !failure && !unpackError) {
        const index = next;
        const [start, end] = ranges[index];
        next += 1;
        try {
          const result = await withRetry(
            'Bucket range download',
            () => this.transfer.getRangeToFile(hit.url, filePath, start, end),
            { sleep: this.sleep }
          );
          if (result.status !== 206 || result.bytes !== end - start + 1) {
            failure = new CacheApiError(`Bucket range answered ${result.status} (${result.bytes} of ${end - start + 1} bytes)`, 'download_failed', result.status);
          } else {
            done[index] = true;
            while (ready < ranges.length && done[ready]) ready += 1;
            follower?.advance(ready === ranges.length ? size : ranges[ready][0]);
          }
        } catch (error) {
          failure = new CacheApiError(error.message, 'network');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RANGE_CONCURRENCY, ranges.length) }, worker));
    if (failure && follower) follower.destroy(failure);
    if (unpacking) await unpacking;
    follower?.destroy();
    // A failed download is the cause when both failed: retry it.
    if (unpackError && !failure) throw unpackError;
    if (!failure) return size;
    if (last) throw failure;
    return null;
  }

  /**
   * Uploads `filePath` under `key`. Returns `committed`, `exists` (already
   * stored) or `in_progress` (another run is uploading it). On a failure the
   * reservation is aborted, best effort, and the error is thrown.
   * `name` (folder mode) stores the readable key; `key` must be cacheKey(tool, name).
   */
  async upload(tool, key, filePath, { name } = {}) {
    const sizeBytes = fs.statSync(filePath).size;
    if (sizeBytes === 0) throw new CacheApiError('Refusing to store an empty object', 'empty_object');
    const reserve = name === undefined ? { tool, key, sizeBytes } : { tool, key, sizeBytes, name };
    const start = await this.call('uploads', reserve);
    if (start.status === 'exists' || start.status === 'in_progress') return start.status;

    try {
      let parts;
      if (start.status === 'upload') await this.putSingle(reserve, filePath, start);
      else if (start.status === 'multipart') parts = await this.putParts(tool, key, filePath, sizeBytes, start);
      else throw new CacheApiError(`Unexpected upload status ${start.status}`, 'bad_response');
      const done = await this.call('commit', parts ? { tool, key, parts } : { tool, key });
      return done.status;
    } catch (error) {
      await this.call('abort', { tool, key }).catch(() => {});
      throw error;
    }
  }

  async putSingle(reserve, filePath, signed) {
    const { sizeBytes } = reserve;
    let current = signed;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let result;
      try {
        result = await withRetry(
          'Bucket upload',
          () => this.transfer.putFile(current.url, { filePath, length: sizeBytes, headers: current.headers ?? {} }),
          { sleep: this.sleep }
        );
      } catch (error) {
        if (attempt === 3) throw new CacheApiError(error.message, 'network');
        current = await this.call('uploads', reserve);
        continue;
      }
      // 412: our own earlier attempt already stored the bytes (create-only URL).
      if (result.status === 200 || result.status === 412) return;
      if (attempt === 3) throw new CacheApiError(`Bucket upload answered ${result.status}`, 'upload_failed', result.status);
      // An expired URL (403) or similar: the same run gets fresh URLs for its own reservation.
      current = await this.call('uploads', reserve);
      if (current.status !== 'upload') throw new CacheApiError(`Upload restarted as ${current.status}`, 'upload_failed');
    }
  }

  async putParts(tool, key, filePath, sizeBytes, start) {
    const { partSizeBytes, partCount } = start;
    // Signed part URLs live 60 s, so sign just before use and re-sign after 45 s.
    const now = () => Date.now();
    const urls = new Map(start.parts.map((p) => [p.partNumber, { url: p.url, at: now() }]));
    const etags = new Map();
    const sizeOf = (n) => (n === partCount ? sizeBytes - partSizeBytes * (partCount - 1) : partSizeBytes);
    const fresh = (n) => urls.has(n) && now() - urls.get(n).at < URL_REFRESH_MS;

    const sign = async (numbers) => {
      const result = await this.call('parts', { tool, key, partNumbers: numbers });
      for (const p of result.parts) urls.set(p.partNumber, { url: p.url, at: now() });
    };

    const pending = Array.from({ length: partCount }, (_, i) => i + 1);
    let next = 0;

    const sendPart = async (n) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (!fresh(n)) {
          // Sign this part and the next few still waiting, in one call.
          const batch = [n, ...pending.slice(next).filter((m) => !fresh(m))].slice(0, PART_CONCURRENCY * 2);
          await sign([...new Set(batch)]);
        }
        let result;
        try {
          result = await withRetry(
            `Bucket part ${n}`,
            () => this.transfer.putFile(urls.get(n).url, { filePath, start: (n - 1) * partSizeBytes, length: sizeOf(n) }),
            { sleep: this.sleep }
          );
        } catch {
          urls.delete(n);
          continue;
        }
        const etag = result.headers?.etag;
        if (result.status === 200 && etag) return etags.set(n, etag);
        urls.delete(n); // expired or refused: sign again
      }
      throw new CacheApiError(`Bucket part ${n} could not be uploaded`, 'upload_failed');
    };

    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, async () => {
      while (next < pending.length) {
        const n = pending[next];
        next += 1;
        await sendPart(n);
      }
    });
    await Promise.all(workers);
    return pending.map((n) => ({ partNumber: n, etag: etags.get(n) }));
  }
}

module.exports = { CacheClient, CacheApiError, cacheKey, MAX_LOOKUP_KEYS };
