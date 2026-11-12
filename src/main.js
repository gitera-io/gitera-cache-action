'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core');
const { startServer } = require('./lib/daemon');
const folderOps = require('./lib/folder');
const { readInputs, InputError } = require('./lib/inputs');
const { CacheClient } = require('./lib/objects');
const { TokenSource, TokenError } = require('./lib/token');

const TURBO_TEAM = 'gitera';

/** `auto` serves both; each tool only ever sends its own paths. */
const toolsFor = (tools) => (tools === 'none' ? [] : tools === 'auto' ? ['turbo', 'nx'] : [tools]);

const workDir = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gitera-cache');

/**
 * Folder mode restore, like actions/cache: the exact key, else the newest
 * restore-keys match. Records what it found for the post step's save.
 */
async function restoreFolder(folder, client, ops) {
  const method = ops.compressionMethod();
  const tool = ops.folderTool(folder.paths, method);
  const state = { tool, method, key: folder.key, exact: false, matched: '' };
  let hit = null;
  const started = Date.now();

  try {
    if (folder.lookupOnly) {
      const found = (await client.call('lookup', { tool, name: folder.key, prefixes: folder.restoreKeys }))?.hit;
      if (found) hit = { name: found.name, exact: found.exact, sizeBytes: found.sizeBytes };
    } else {
      fs.mkdirSync(workDir(), { recursive: true });
      const archive = path.join(workDir(), `restore-${process.pid}.archive`);
      try {
        // Unpacks while the archive downloads.
        const extract = (input) => ops.extractStream(input, method);
        hit = await client.restore(tool, folder.key, folder.restoreKeys, archive, { extract });
      } finally {
        fs.rmSync(archive, { force: true });
      }
    }
  } catch (error) {
    hit = null;
    core.warning(`Gitera Cache: folder restore failed (${error.code ?? 'error'}): ${error.message}`);
  }
  if (hit && !folder.lookupOnly) {
    core.info(`Gitera Cache: lookup, download and extract ${Date.now() - started} ms`);
  }

  if (hit) {
    state.exact = hit.exact;
    state.matched = hit.name;
    core.setOutput('cache-hit', String(hit.exact));
    core.setOutput('cache-matched-key', hit.name);
    const verb = folder.lookupOnly ? 'found' : 'restored';
    core.info(`Gitera Cache: ${verb} ${hit.exact ? 'key' : 'restore key match'} ${hit.name} (${(hit.sizeBytes / 1024 / 1024).toFixed(1)} MiB)`);
  } else {
    core.info(`Gitera Cache: no cache found for key ${folder.key}`);
    if (folder.failOnCacheMiss) core.setFailed(`No cache found for key ${folder.key} or its restore keys`);
  }
  core.saveState('folder', JSON.stringify(state));
}

/**
 * Main step. Checks the inputs and the connection, restores the folder cache,
 * then starts the local build-tool cache server and points Turbo and Nx at it.
 *
 * A cache must never break a build: anything other than a bad input (or
 * fail-on-cache-miss) is a warning, and the step still succeeds.
 */
async function run({
  tokenSourceFor = (apiUrl) => new TokenSource(apiUrl, { onToken: (t) => core.setSecret(t.token) }),
  clientFor = (apiUrl, tokens) => new CacheClient(apiUrl, tokens),
  start = startServer,
  ops = folderOps,
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

  const tokens = tokenSourceFor(inputs.apiUrl);
  let session;
  const connectStarted = Date.now();
  try {
    session = await tokens.refresh();
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    const hint = error.hint ? ` ${error.hint}` : '';
    core.warning(`Gitera Cache is off for this job (${error.code}): ${error.message}.${hint}`);
    core.saveState('disabled', error.code);
    if (inputs.folder?.failOnCacheMiss) core.setFailed(`No cache found for key ${inputs.folder.key}: Gitera Cache is off`);
    return;
  }
  core.info(`Gitera Cache: connected for ${session.repository ?? 'this repository'} (${Date.now() - connectStarted} ms)`);
  // The post step reuses this token while it has more than 5 minutes left, so a
  // save does not trade a second OIDC token. Masked above by onToken.
  if (session.token) core.saveState('token', JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));

  if (inputs.folder) await restoreFolder(inputs.folder, clientFor(inputs.apiUrl, tokens), ops);

  const tools = toolsFor(inputs.tools);
  if (tools.length > 0) {
    try {
      const server = await start({ apiUrl: inputs.apiUrl, tools, dir: workDir() });
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
}

if (require.main === module) {
  run().catch((error) => {
    core.warning(`Gitera Cache skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

module.exports = { run, toolsFor };
