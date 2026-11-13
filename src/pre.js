'use strict';

/**
 * Pre step: runs at the start of the job, before checkout. Starts the
 * background prefetch (src/prefetch-process.js) and returns at once, so the
 * login and, in folder mode, the download of the best `restore-keys` match
 * happen while the job's first steps run. See src/lib/prefetch.js.
 *
 * Never fails the job: if anything here goes wrong, the main step simply
 * does all the work itself.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./lib/core');
const { prefetchDir, readStatus } = require('./lib/prefetch');

const STARTED_TIMEOUT_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run({ dir = prefetchDir(), entry = path.join(__dirname, 'prefetch-process.js') } = {}) {
  if (!dir) return; // Not on a runner.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return; // No id-token permission: the main step explains.

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, 'prefetch.log'), 'a');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, GITERA_PREFETCH_DIR: dir },
  });
  fs.closeSync(out);
  child.unref();

  // Wait until the prefetch has written its first status, so the main step
  // always finds it once this step is over.
  const deadline = Date.now() + STARTED_TIMEOUT_MS;
  while (Date.now() < deadline && !readStatus(dir)) await sleep(20);
  core.info(readStatus(dir) ? 'Gitera Cache: started the login and restore in the background' : 'Gitera Cache: background start timed out');
}

if (require.main === module) {
  run().catch(() => {});
}

module.exports = { run };
