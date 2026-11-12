'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core');
const { stopServer } = require('./lib/daemon');
const folderOps = require('./lib/folder');
const { CacheClient, cacheKey } = require('./lib/objects');
const { TokenSource } = require('./lib/token');

const MIB = 1024 * 1024;

function summary(stats) {
  const lookups = stats.hits + stats.misses;
  const rate = lookups > 0 ? `${Math.round((stats.hits / lookups) * 100)}%` : 'n/a';
  return [
    '### Gitera Cache',
    '',
    '| Hits | Misses | Hit rate | Uploaded | Downloaded | Skipped | Errors |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${stats.hits} | ${stats.misses} | ${rate} | ${stats.uploads} (${(stats.bytesUp / MIB).toFixed(1)} MiB) | ${(stats.bytesDown / MIB).toFixed(1)} MiB | ${stats.skipped} | ${stats.errors} |`,
    '',
  ].join('\n');
}

async function stopBuildToolServer(stop) {
  const saved = core.getState('server');
  if (!saved) return;
  const server = JSON.parse(saved);
  const stats = await stop(server);
  if (!stats) return;
  core.info(`Gitera Cache: ${stats.hits} hit(s), ${stats.misses} miss(es), ${stats.uploads} upload(s), ${stats.errors} error(s)`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(stats));
  if (stats.errors > 0 && server.logFile && fs.existsSync(server.logFile)) {
    const tail = fs.readFileSync(server.logFile, 'utf8').trim().split('\n').slice(-5).join('\n');
    core.info(`Gitera Cache server log (last lines):\n${tail}`);
  }
}

/** Saves the folder cache under its key, unless the exact key was restored. */
async function saveFolder(clientFor, ops) {
  const saved = core.getState('folder');
  const inputs = core.getState('inputs');
  if (!saved || !inputs) return;
  const state = JSON.parse(saved);
  const { folder, apiUrl } = JSON.parse(inputs);
  if (folder.lookupOnly) return;
  if (state.exact) return core.info(`Gitera Cache: key ${state.key} was restored exactly, not saving`);

  const paths = ops.resolvePaths(folder.paths);
  if (paths.length === 0) return core.warning('Gitera Cache: no path matched, nothing saved');

  const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gitera-cache');
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `save-${process.pid}.archive`);
  try {
    const started = Date.now();
    await ops.createArchive(paths, archive, state.method);
    const packed = Date.now();
    const size = fs.statSync(archive).size;
    const client = clientFor(apiUrl);
    const result = await client.upload(state.tool, cacheKey(state.tool, state.key), archive, { name: state.key });
    const sizeText = `${(size / MIB).toFixed(1)} MiB`;
    core.info(`Gitera Cache: pack ${packed - started} ms, upload ${Date.now() - packed} ms`);
    if (result === 'committed') core.info(`Gitera Cache: saved key ${state.key} (${sizeText})`);
    else if (result === 'exists') core.info(`Gitera Cache: key ${state.key} already exists, not saving`);
    else core.info(`Gitera Cache: another job is saving key ${state.key}`);
  } catch (error) {
    core.warning(`Gitera Cache: folder save failed (${error.code ?? 'error'}): ${error.message}`);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/** The main step's token, if it still has more than the refresh margin left. */
function handedOverToken() {
  try {
    const saved = JSON.parse(core.getState('token') || 'null');
    return saved && typeof saved.token === 'string' && Number.isFinite(saved.expiresAt) ? saved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Post step (runs when the job succeeded, like actions/cache). Waits for the
 * build-tool cache server's uploads, stops it, writes the job summary, and
 * saves the folder cache. Never fails the job.
 */
async function run({
  stop = stopServer,
  clientFor = (apiUrl) =>
    new CacheClient(apiUrl, new TokenSource(apiUrl, { initial: handedOverToken(), onToken: (t) => core.setSecret(t.token) })),
  ops = folderOps,
} = {}) {
  if (core.getState('disabled')) return;
  try {
    await stopBuildToolServer(stop);
  } catch (error) {
    core.warning(`Gitera Cache: stopping the build-tool cache failed: ${error.message}`);
  }
  await saveFolder(clientFor, ops);
}

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Gitera Cache post step skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

module.exports = { run, summary };
