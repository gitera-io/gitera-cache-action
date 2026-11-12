'use strict';

/**
 * Work started at job start by the pre step (src/pre.js), so it runs while
 * checkout, setup-node and the other early steps do:
 *
 * 1. Log in to Gitera (OIDC exchange), with the folder lookup.
 * 2. Folder mode: download the best match of `restore-keys` and unpack it
 *    into a staging folder in RUNNER_TEMP. `hashFiles()` is still empty at
 *    job start, so the exact key is not known yet; the main step checks the
 *    staged object's name against the real key before using it.
 *
 * The pre step starts src/prefetch-process.js in the background and returns.
 * That process reports through a status file; the main step waits for it,
 * then moves the staged folders into place (a rename on the same disk).
 */

const fs = require('node:fs');
const path = require('node:path');

const STATUS_FILE = 'prefetch.json';
const POLL_MS = 50;
/** The main step waits at most this long for a prefetch that is still running. */
const WAIT_TIMEOUT_MS = 15 * 60 * 1000;

/** Where the pre step and the main step meet; null outside a runner (no RUNNER_TEMP). */
const prefetchDir = (env = process.env) => (env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, 'gitera-cache', 'prefetch') : null);

const statusPath = (dir) => path.join(dir, STATUS_FILE);

/** Writes the status atomically, readable by this user only (it holds the cache token). */
function writeStatus(dir, status) {
  fs.mkdirSync(dir, { recursive: true });
  const file = statusPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readStatus(dir) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops a prefetch and its tar and zstd children (it runs in its own process group). */
function stopPrefetch(status) {
  if (!status?.pid) return;
  for (const target of [-status.pid, status.pid]) {
    try {
      process.kill(target, 'SIGTERM');
      return;
    } catch {
      // try the next form, or already gone
    }
  }
}

/**
 * Waits for the prefetch until `until(status)` is true (by default: until it
 * is no longer running). Returns that status, or null when no prefetch ran
 * (no pre step, or a local action). A prefetch still running after
 * `timeoutMs`, or whose process died without finishing, is stopped and
 * returns its last status with `state: 'abandoned'`, so the main step does
 * the work itself.
 */
async function waitForPrefetch(
  dir,
  { until = (status) => status.state !== 'running', timeoutMs = WAIT_TIMEOUT_MS, sleep = defaultSleep, now = Date.now } = {}
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = readStatus(dir);
    if (!status) return null;
    if (status.state !== 'running' || until(status)) return status;
    if (!alive(status.pid)) return { ...status, state: 'abandoned' };
    if (now() >= deadline) {
      stopPrefetch(status);
      return { ...status, state: 'abandoned' };
    }
    await sleep(POLL_MS);
  }
}

/** Renames `from` to `to`, copying instead when they are on different disks. */
function renameOrCopy(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves everything under `stagingRoot` to the same path under `destRoot`
 * (`/` for an archive made with absolute paths). Missing folders move in one
 * rename; folders that already exist are merged; files and links replace
 * what is there, like `tar -x` would.
 */
function moveInto(stagingRoot, destRoot = '/') {
  for (const name of fs.readdirSync(stagingRoot)) {
    const from = path.join(stagingRoot, name);
    const to = path.join(destRoot, name);
    const source = fs.lstatSync(from);
    let target = null;
    try {
      target = fs.lstatSync(to);
    } catch {
      target = null;
    }
    if (!target) {
      renameOrCopy(from, to);
    } else if (source.isDirectory() && target.isDirectory()) {
      moveInto(from, to);
    } else {
      fs.rmSync(to, { recursive: true, force: true });
      renameOrCopy(from, to);
    }
  }
}

/** Removes the status file and any staged folder; best effort. */
function discard(dir, status) {
  if (status?.staged?.root) fs.rmSync(status.staged.root, { recursive: true, force: true });
  fs.rmSync(statusPath(dir), { force: true });
}

module.exports = { prefetchDir, writeStatus, readStatus, waitForPrefetch, stopPrefetch, moveInto, discard, statusPath, WAIT_TIMEOUT_MS };
