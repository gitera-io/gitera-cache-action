'use strict';

const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core');
const { startServer } = require('./lib/daemon');
const { readInputs, InputError } = require('./lib/inputs');
const { TokenSource, TokenError } = require('./lib/token');

const TURBO_TEAM = 'gitera';

/** `auto` serves both; each tool only ever sends its own paths. */
const toolsFor = (tools) => (tools === 'none' ? [] : tools === 'auto' ? ['turbo', 'nx'] : [tools]);

/**
 * Main step. Checks the inputs and the connection, then starts the local
 * build-tool cache server and points Turbo and Nx at it. Folder restore
 * (P2-5) plugs in here.
 *
 * A cache must never break a build: anything other than a bad input is a
 * warning, and the step still succeeds.
 */
async function run({
  tokenSourceFor = (apiUrl) => new TokenSource(apiUrl, { onToken: (t) => core.setSecret(t.token) }),
  start = startServer,
} = {}) {
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

  const tools = toolsFor(inputs.tools);
  if (tools.length > 0) {
    try {
      const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gitera-cache');
      const server = await start({ apiUrl: inputs.apiUrl, tools, dir });
      core.setSecret(server.secret);
      core.saveState('server', JSON.stringify(server));
      const url = `http://127.0.0.1:${server.port}`;
      if (tools.includes('turbo')) {
        core.exportVariable('TURBO_API', url);
        core.exportVariable('TURBO_TOKEN', server.secret);
        core.exportVariable('TURBO_TEAM', TURBO_TEAM);
      }
      if (tools.includes('nx')) {
        core.exportVariable('NX_SELF_HOSTED_REMOTE_CACHE_SERVER', url);
        core.exportVariable('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN', server.secret);
      }
      core.info(`Gitera Cache: ${tools.join(' and ')} remote cache on ${url}`);
    } catch (error) {
      core.warning(`Gitera Cache: the build-tool cache could not start (${error.message}). Builds run without it.`);
    }
  }

  if (inputs.folder) core.notice('Gitera Cache: folder mode is not active yet in this build.');
}

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Gitera Cache skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

module.exports = { run, toolsFor };
