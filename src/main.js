'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./lib/core');
const { startServer } = require('./lib/daemon');
const folderOps = require('./lib/folder');
const { readInputs, InputError } = require('./lib/inputs');
const { CacheClient } = require('./lib/objects');
const { prefetchDir, waitForPrefetch, moveInto, discard, stopPrefetch } = require('./lib/prefetch');
const { TokenSource, TokenError, REFRESH_MARGIN_MS } = require('./lib/token');

const TURBO_TEAM = 'gitera';

/** `auto` serves both; each tool only ever sends its own paths. */
const toolsFor = (tools) => (tools === 'none' ? [] : tools === 'auto' ? ['turbo', 'nx'] : [tools]);

const workDir = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gitera-cache');

/** The compression and the cache space (`folder-<hex>`) for the folder inputs. */
function folderSpace(folder, ops) {
  const method = ops.compressionMethod();
  return { method, tool: ops.folderTool(folder.paths, method) };
}

/**
 * Folder mode restore, like actions/cache: the exact key, else the newest
 * restore-keys match. Records what it found for the post step's save.
 * `first` is the lookup result that came back with the login, if any.
 */
async function restoreFolder(folder, client, ops, { tool, method, first }) {
  let hit = null;
  const started = Date.now();

  try {
    if (folder.lookupOnly) {
      const found = first ? first.hit : (await client.call('lookup', { tool, name: folder.key, prefixes: folder.restoreKeys }))?.hit;
      if (found) hit = { name: found.name, exact: found.exact, sizeBytes: found.sizeBytes };
    } else {
      fs.mkdirSync(workDir(), { recursive: true });
      const archive = path.join(workDir(), `restore-${process.pid}.archive`);
      try {
        // Unpacks while the archive downloads.
        const extract = (input) => ops.extractStream(input, method);
        hit = await client.restore(tool, folder.key, folder.restoreKeys, archive, { extract, first });
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
  recordFolder(folder, { tool, method }, hit);
}

/**
 * Folder restore from the job-start prefetch. The prefetch staged the best
 * restore-keys match it could see before checkout; it is used only when it
 * is what a restore would pick now: its name is the key, or one lookup
 * returns the same name. Otherwise the prefetch is stopped and the restore
 * runs as usual. Returns false when the caller should do a normal restore.
 */
async function restoreFromPrefetch(folder, client, space, early, prefetch) {
  const candidate = early.staged ?? early.speculating;
  if (!candidate) {
    prefetch.stop(early);
    return { used: false, first: knownMiss(folder, space, early.missed) ? { hit: null } : undefined };
  }
  if (candidate.tool !== space.tool) {
    prefetch.stop(early);
    return { used: false };
  }
  let first;
  if (candidate.name !== folder.key) {
    let found;
    try {
      found = (await client.call('lookup', { tool: space.tool, name: folder.key, prefixes: folder.restoreKeys }))?.hit ?? null;
    } catch {
      found = undefined; // the normal restore looks up again
    }
    if (!found || found.name !== candidate.name) {
      prefetch.stop(early);
      return { used: false, first: found === undefined ? undefined : { hit: found } };
    }
    first = { hit: found };
  }

  const started = Date.now();
  const status = early.state === 'running' ? await prefetch.wait() : early;
  if (status?.staged?.name !== candidate.name || status.staged.tool !== space.tool) return { used: false, first };
  try {
    prefetch.move(status.staged.root);
  } catch (error) {
    core.warning(`Gitera Cache: could not use the restore started at job start (${error.message}); restoring again`);
    return { used: false };
  }
  const waited = Date.now() - started;
  core.info(`Gitera Cache: restored in the background at job start (${status.restoreMs ?? '?'} ms), waited ${waited} ms`);
  recordFolder(folder, space, { name: candidate.name, exact: candidate.name === folder.key, sizeBytes: status.staged.sizeBytes });
  return { used: true };
}

/**
 * True when the job-start lookup already proves a miss: it found nothing for
 * the same restore keys in the same cache space, and the key starts with one
 * of them (so an object stored under the key would have matched).
 */
function knownMiss(folder, space, missed) {
  if (!missed || missed.tool !== space.tool) return false;
  const same = missed.prefixes.length === folder.restoreKeys.length && missed.prefixes.every((p, i) => p === folder.restoreKeys[i]);
  return same && folder.restoreKeys.some((prefix) => prefix && folder.key.startsWith(prefix));
}

/** Sets the outputs and the state for the post step's save. */
function recordFolder(folder, { tool, method }, hit) {
  const state = { tool, method, key: folder.key, exact: false, matched: '' };
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

/** The job-start prefetch on a runner, or null (tests, local runs). */
function defaultPrefetch() {
  const dir = prefetchDir();
  if (!dir) return null;
  return {
    wait: (options) => waitForPrefetch(dir, options),
    move: (root) => moveInto(root, '/'),
    discard: (status) => discard(dir, status),
    stop: stopPrefetch,
  };
}

/**
 * Main step. Checks the inputs and the connection, restores the folder cache,
 * then starts the local build-tool cache server and points Turbo and Nx at it.
 *
 * A cache must never break a build: anything other than a bad input (or
 * fail-on-cache-miss) is a warning, and the step still succeeds.
 */
async function run({
  tokenSourceFor = (apiUrl, options = {}) => new TokenSource(apiUrl, { ...options, onToken: (t) => core.setSecret(t.token) }),
  clientFor = (apiUrl, tokens) => new CacheClient(apiUrl, tokens),
  start = startServer,
  ops = folderOps,
  prefetch = defaultPrefetch(),
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

  const space = inputs.folder ? folderSpace(inputs.folder, ops) : null;
  const restoring = inputs.folder && !inputs.folder.lookupOnly;
  // The pre step started the login (and maybe the restore) at job start. Wait
  // for the login, and in folder mode until we know what it is downloading.
  let early = null;
  try {
    early = prefetch ? await prefetch.wait({ until: (s) => (restoring ? Boolean(s.speculating) : Boolean(s.token)) }) : null;
  } catch {
    early = null;
  }
  const reuse = early?.token?.token && early.token.expiresAt - Date.now() > REFRESH_MARGIN_MS ? early.token : null;

  try {
    const tokens = tokenSourceFor(inputs.apiUrl, reuse ? { initial: reuse } : {});
    let session;
    if (reuse) {
      core.setSecret(reuse.token);
      session = reuse;
      core.info(`Gitera Cache: connected for ${reuse.repository ?? 'this repository'} at job start (${early.loginMs ?? '?'} ms, in the background)`);
    } else {
      // Folder mode asks for its lookup with the login, saving one API call.
      const lookup = space ? { tool: space.tool, name: inputs.folder.key, prefixes: inputs.folder.restoreKeys } : null;
      const connectStarted = Date.now();
      try {
        session = await tokens.refresh(lookup ? { lookup } : {});
      } catch (error) {
        if (!(error instanceof TokenError)) throw error;
        const hint = error.hint ? ` ${error.hint}` : '';
        core.warning(`Gitera Cache is off for this job (${error.code}): ${error.message}.${hint}`);
        core.saveState('disabled', error.code);
        if (inputs.folder?.failOnCacheMiss) core.setFailed(`No cache found for key ${inputs.folder.key}: Gitera Cache is off`);
        return;
      }
      core.info(`Gitera Cache: connected for ${session.repository ?? 'this repository'} (${Date.now() - connectStarted} ms)`);
    }
    // The post step reuses this token while it has more than 5 minutes left, so a
    // save does not trade a second OIDC token. Masked above (setSecret / onToken).
    if (session.token) core.saveState('token', JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));

    if (inputs.folder) {
      const client = clientFor(inputs.apiUrl, tokens);
      let fromPrefetch = { used: false };
      if (reuse && restoring) fromPrefetch = await restoreFromPrefetch(inputs.folder, client, space, early, prefetch);
      if (!fromPrefetch.used) {
        await restoreFolder(inputs.folder, client, ops, { ...space, first: fromPrefetch.first ?? session.lookup });
      }
    }
  } finally {
    if (early) {
      if (early.state === 'running') prefetch.stop(early);
      prefetch.discard(early);
    }
  }

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
