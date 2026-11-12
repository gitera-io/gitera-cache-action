'use strict';

const core = require('./core');

const TOOLS = ['auto', 'turbo', 'nx', 'none'];
/** Same limit as actions/cache. */
const MAX_KEY_LENGTH = 512;

class InputError extends Error {}

function checkKey(key, what) {
  if (key.length > MAX_KEY_LENGTH) throw new InputError(`${what} is longer than ${MAX_KEY_LENGTH} characters`);
  if (key.includes(',')) throw new InputError(`${what} cannot contain a comma`);
  return key;
}

/**
 * Reads and checks every input. Folder mode is on when `path` is set; the
 * build-tool cache server is on unless `tools` is `none`. At least one must be on.
 */
function readInputs() {
  const paths = core.getMultilineInput('path');
  const key = core.getInput('key');
  const restoreKeys = core.getMultilineInput('restore-keys');
  const tools = (core.getInput('tools') || 'auto').toLowerCase();
  const apiUrl = core.getInput('api-url') || 'https://app.gitera.io';

  if (!TOOLS.includes(tools)) throw new InputError(`tools must be one of ${TOOLS.join(', ')}, got "${tools}"`);

  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new InputError(`api-url is not a URL: "${apiUrl}"`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new InputError('api-url must use https');
  }

  const folder = paths.length > 0;
  if (folder && !key) throw new InputError('key is required when path is set');
  if (!folder && (key || restoreKeys.length > 0)) throw new InputError('key and restore-keys need path');
  if (!folder && tools === 'none') throw new InputError('nothing to do: set path, or tools other than none');

  return {
    folder: folder
      ? {
          paths,
          key: checkKey(key, 'key'),
          restoreKeys: restoreKeys.map((k, i) => checkKey(k, `restore-keys line ${i + 1}`)),
          lookupOnly: core.getBooleanInput('lookup-only'),
          failOnCacheMiss: core.getBooleanInput('fail-on-cache-miss'),
        }
      : null,
    tools,
    apiUrl: url.origin,
  };
}

module.exports = { readInputs, InputError, MAX_KEY_LENGTH };
