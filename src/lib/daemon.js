'use strict';

/**
 * Starts and stops the background cache server (src/server-process.js).
 *
 * The child is detached with its output in a log file, so the main step can
 * end while the server keeps serving the later steps. Nothing is inherited
 * from the step's stdout: the runner would otherwise wait for it.
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const READY_TIMEOUT_MS = 15 * 1000;
const FLUSH_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns `{ port, pid, secret, logFile }` once the server listens. */
async function startServer({ apiUrl, tools, dir, entry = path.join(__dirname, '..', 'server-process.js') }) {
  fs.mkdirSync(dir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('base64url');
  const readyFile = path.join(dir, `ready-${process.pid}.json`);
  const logFile = path.join(dir, 'gitera-cache-server.log');
  fs.rmSync(readyFile, { force: true });
  const out = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      GITERA_CACHE_API_URL: apiUrl,
      GITERA_CACHE_SECRET: secret,
      GITERA_CACHE_TOOLS: tools.join(','),
      GITERA_CACHE_READY_FILE: readyFile,
    },
  });
  fs.closeSync(out);
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      const { port, pid } = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      return { port, pid, secret, logFile };
    }
    if (exited !== null) break;
    await sleep(100);
  }
  try {
    process.kill(child.pid);
  } catch {
    // already gone
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ') : '';
  throw new Error(`cache server did not start${tail ? `: ${tail}` : ''}`);
}

/** Waits for queued uploads, returns the server's stats, then stops it. */
async function stopServer({ port, pid, secret }) {
  let stats = null;
  try {
    stats = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/_gitera/flush', method: 'POST', headers: { Authorization: `Bearer ${secret}` }, timeout: FLUSH_TIMEOUT_MS },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('flush timed out')));
      req.on('error', reject);
      req.end();
    });
  } finally {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  return stats;
}

module.exports = { startServer, stopServer };
