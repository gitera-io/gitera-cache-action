'use strict';

const core = require('./lib/core');

/**
 * Post step (runs when the job succeeded, like actions/cache). P2-1 scaffold.
 * Later: stop the build-tool cache server, save the folder cache, and write
 * hits, misses and bytes to the job summary. Never fails the job.
 */
async function run() {
  const saved = core.getState('inputs');
  if (!saved) return;
  const inputs = JSON.parse(saved);
  if (inputs.folder) core.info(`Gitera Cache: would save key ${inputs.folder.key}`);
}

run().catch((error) => {
  core.warning(`Gitera Cache post step skipped: ${error instanceof Error ? error.message : String(error)}`);
});
