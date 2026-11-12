'use strict';

/**
 * Streams bytes between a file and a signed bucket URL with node:http(s), so
 * a large object never sits in memory and Content-Length is exact (the
 * signed URL is bound to it).
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const TIMEOUT_MS = 10 * 60 * 1000;

function clientFor(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new Error(`Unsupported URL scheme: ${url.protocol}`);
}

function collect(res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      if (size < 4096) chunks.push(chunk);
      size += chunk.length;
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').slice(0, 4096)));
    res.on('error', () => resolve(''));
  });
}

/**
 * PUTs `length` bytes of `filePath` from `start`.
 * Resolves `{ status, headers, body }`; rejects only when no response came back.
 */
function putFile(signedUrl, { filePath, start = 0, length, headers = {} }) {
  const url = new URL(signedUrl);
  return new Promise((resolve, reject) => {
    const req = clientFor(url).request(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': String(length) },
      timeout: TIMEOUT_MS,
    });
    req.on('timeout', () => req.destroy(new Error('Upload timed out')));
    req.on('error', reject);
    req.on('response', async (res) => {
      const body = await collect(res);
      resolve({ status: res.statusCode, headers: res.headers, body });
    });
    if (length === 0) return req.end();
    const source = fs.createReadStream(filePath, { start, end: start + length - 1 });
    source.on('error', (error) => req.destroy(error));
    source.pipe(req);
  });
}

/**
 * GETs a signed URL into `filePath`. Resolves `{ status, headers, bytes }`.
 * The file is written only for a 2xx answer.
 */
function getToFile(signedUrl, filePath) {
  const url = new URL(signedUrl);
  return new Promise((resolve, reject) => {
    const req = clientFor(url).get(url, { timeout: TIMEOUT_MS }, async (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await collect(res);
        return resolve({ status: res.statusCode, headers: res.headers, bytes: 0 });
      }
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
      });
      try {
        await pipeline(res, fs.createWriteStream(filePath));
        resolve({ status: res.statusCode, headers: res.headers, bytes });
      } catch (error) {
        reject(error);
      }
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

module.exports = { putFile, getToFile };
