'use strict';

const core = require('./lib/core');
const { readInputs, InputError } = require('./lib/inputs');

/**
 * Main step. P2-1 scaffold: checks the inputs and records them for the post
 * step. The token client (P2-2), object client (P2-3), build-tool cache
 * server (P2-4) and folder restore (P2-5) plug in here.
 *
 * A cache must never break a build: anything other than a bad input is a
 * warning, and the step still succeeds.
 */
async function run() {
  let inputs;
  try {
    inputs = readInputs();
  } catch (error) {
    if (error instanceof InputError) return core.setFailed(error.message);
    throw error;
  }

  core.saveState('inputs', JSON.stringify(inputs));
  core.setOutput('cache-hit', 'false');
  core.setOutput('cache-matched-key', '');

  if (inputs.folder) core.info(`Gitera Cache: folder mode for ${inputs.folder.paths.length} path(s), key ${inputs.folder.key}`);
  if (inputs.tools !== 'none') core.info(`Gitera Cache: build-tool cache (${inputs.tools})`);
  core.notice('Gitera Cache is not active yet: this build of the action only checks its inputs.');
}

run().catch((error) => {
  core.warning(`Gitera Cache skipped: ${error instanceof Error ? error.message : String(error)}`);
});
