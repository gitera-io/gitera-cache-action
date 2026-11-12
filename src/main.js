'use strict';

const core = require('./lib/core');
const { readInputs, InputError } = require('./lib/inputs');
const { TokenSource, TokenError } = require('./lib/token');

/**
 * Main step. Checks the inputs, then gets a Gitera cache token so a broken
 * setup shows up at the top of the job. The object client (P2-3), build-tool
 * cache server (P2-4) and folder restore (P2-5) plug in here.
 *
 * A cache must never break a build: anything other than a bad input is a
 * warning, and the step still succeeds.
 */
async function run({ tokenSourceFor = (apiUrl) => new TokenSource(apiUrl, { onToken: (t) => core.setSecret(t.token) }) } = {}) {
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

  let session;
  try {
    session = await tokenSourceFor(inputs.apiUrl).refresh();
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    const hint = error.hint ? ` ${error.hint}` : '';
    core.warning(`Gitera Cache is off for this job (${error.code}): ${error.message}.${hint}`);
    core.saveState('disabled', error.code);
    return;
  }

  core.info(`Gitera Cache: connected for ${session.repository ?? 'this repository'}`);
  if (inputs.folder) core.info(`Gitera Cache: folder mode for ${inputs.folder.paths.length} path(s), key ${inputs.folder.key}`);
  if (inputs.tools !== 'none') core.info(`Gitera Cache: build-tool cache (${inputs.tools})`);
  core.notice('Gitera Cache is not storing anything yet: this build only checks inputs and the connection.');
}

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Gitera Cache skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

module.exports = { run };
