'use strict';

const fs = require('node:fs');

const core = require('./lib/core');
const { stopServer } = require('./lib/daemon');

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

/**
 * Post step (runs when the job succeeded, like actions/cache). Waits for the
 * build-tool cache server's uploads, stops it, and writes the job summary.
 * Folder save (P2-5) plugs in here. Never fails the job.
 */
async function run({ stop = stopServer } = {}) {
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

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Gitera Cache post step skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

module.exports = { run, summary };
