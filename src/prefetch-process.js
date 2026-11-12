'use strict';

/**
 * Background prefetch, started by the pre step (src/pre.js); see
 * src/lib/prefetch.js. Logs in, and in folder mode downloads and stages the
 * best `restore-keys` match, then writes its result to the status file.
 * It never fails the job: anything that goes wrong is left for the main step.
 */

const fs = require('node:fs');
const path = require('node:path');

const core = require('./lib/core');
const folderOps = require('./lib/folder');
const { readInputs } = require('./lib/inputs');
const { CacheClient } = require('./lib/objects');
const { writeStatus } = require('./lib/prefetch');
const { TokenSource } = require('./lib/token');

const DEFAULT_API_URL = 'https://app.gitera.io';

/**
 * The inputs as far as they are known at job start. A `key` made only of
 * `hashFiles()` is still empty then, so strict checks may fail; the login can
 * still go ahead against the default API (never a URL that failed its check).
 */
function inputsAtJobStart() {
  try {
    return readInputs();
  } catch {
    const apiUrl = core.getInput('api-url');
    return !apiUrl || apiUrl.replace(/\/+$/, '') === DEFAULT_API_URL ? { folder: null, apiUrl: DEFAULT_API_URL } : null;
  }
}

async function prefetch({
  dir = process.env.GITERA_PREFETCH_DIR,
  tokenSourceFor = (apiUrl) => new TokenSource(apiUrl),
  clientFor = (apiUrl, tokens) => new CacheClient(apiUrl, tokens),
  ops = folderOps,
  now = Date.now,
} = {}) {
  const started = now();
  const status = { state: 'running', pid: process.pid, startedAt: started };
  writeStatus(dir, status);

  try {
    const inputs = inputsAtJobStart();
    if (!inputs) throw new Error('inputs are not usable at job start');
    const folder = inputs.folder;
    // Only restore-keys can be known at job start: hashFiles() in `key` is still empty.
    const speculate = folder && !folder.lookupOnly && folder.restoreKeys.length > 0;
    const method = folder ? ops.compressionMethod() : null;
    const tool = folder ? ops.folderTool(folder.paths, method) : null;
    const lookup = speculate ? { tool, name: folder.key, prefixes: folder.restoreKeys } : null;

    const tokens = tokenSourceFor(inputs.apiUrl);
    const session = await tokens.refresh(lookup ? { lookup } : {});
    status.token = { token: session.token, expiresAt: session.expiresAt, repository: session.repository };
    status.loginMs = now() - started;
    writeStatus(dir, status);

    if (speculate && session.lookup?.hit) {
      const root = path.join(dir, `staging-${process.pid}`);
      const archive = path.join(dir, `prefetch-${process.pid}.archive`);
      fs.mkdirSync(root, { recursive: true });
      // Lets the main step decide early whether this download is the one it needs.
      status.speculating = { tool, name: session.lookup.hit.name, sizeBytes: session.lookup.hit.sizeBytes };
      writeStatus(dir, status);
      const restoreStarted = now();
      try {
        const extract = (input) => ops.extractStream(input, method, { root });
        const hit = await clientFor(inputs.apiUrl, tokens).restore(tool, folder.key, folder.restoreKeys, archive, {
          extract,
          first: session.lookup,
        });
        if (hit) status.staged = { root, tool, name: hit.name, sizeBytes: hit.sizeBytes };
        else fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(root, { recursive: true, force: true });
        status.restoreError = error.code ?? error.message;
      } finally {
        fs.rmSync(archive, { force: true });
      }
      status.restoreMs = now() - restoreStarted;
    }
    status.state = 'done';
  } catch (error) {
    status.state = 'failed';
    status.error = error.code ?? (error instanceof Error ? error.message : String(error));
  }
  writeStatus(dir, status);
  return status;
}

if (require.main === module) {
  prefetch().catch(() => {
    // The main step does the work itself when no final status was written.
  });
}

module.exports = { prefetch };
