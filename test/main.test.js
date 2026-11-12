'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { run, toolsFor } = require('../src/main');
const post = require('../src/post');
const { TokenError } = require('../src/lib/token');

let dir;
let stdout;
const realWrite = process.stdout.write.bind(process.stdout);
const ENV_KEYS = ['GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY', 'TURBO_API', 'TURBO_TOKEN', 'TURBO_TEAM', 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER', 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN', 'STATE_server'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-main-'));
  process.env.GITHUB_OUTPUT = path.join(dir, 'out');
  process.env.GITHUB_STATE = path.join(dir, 'state');
  process.env.GITHUB_ENV = path.join(dir, 'env');
  stdout = '';
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  process.exitCode = undefined;
});

afterEach(() => {
  process.stdout.write = realWrite;
  for (const name of Object.keys(process.env)) if (name.startsWith('INPUT_')) delete process.env[name];
  for (const name of ENV_KEYS) delete process.env[name];
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const read = (file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
const source = (refresh) => () => ({ refresh });
const connected = source(async () => ({ token: 't', repository: 'acme/web' }));
const fakeStart = (calls = []) => async (options) => {
  calls.push(options);
  return { port: 4321, pid: 1, secret: 'local-secret', logFile: '' };
};

describe('main step', () => {
  it('starts the cache server and points Turbo and Nx at it', async () => {
    const calls = [];
    await run({ tokenSourceFor: connected, start: fakeStart(calls) });
    assert.deepEqual(calls[0].tools, ['turbo', 'nx']);
    const env = read('env');
    for (const name of ['TURBO_API', 'TURBO_TOKEN', 'TURBO_TEAM', 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER', 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN']) {
      assert.match(env, new RegExp(`^${name}<<`, 'm'));
    }
    assert.match(env, /http:\/\/127\.0\.0\.1:4321/);
    assert.match(stdout, /::add-mask::local-secret/);
    assert.match(read('state'), /server<</);
  });

  it('starts only the chosen tool', async () => {
    process.env.INPUT_TOOLS = 'nx';
    await run({ tokenSourceFor: connected, start: fakeStart() });
    assert.doesNotMatch(read('env'), /TURBO_API/);
    assert.match(read('env'), /NX_SELF_HOSTED_REMOTE_CACHE_SERVER/);
  });

  it('does not start a server for folder mode alone', async () => {
    Object.assign(process.env, { INPUT_PATH: 'dist', INPUT_KEY: 'k', INPUT_TOOLS: 'none' });
    const calls = [];
    await run({ tokenSourceFor: connected, start: fakeStart(calls) });
    assert.equal(calls.length, 0);
  });

  it('warns and goes on when the server cannot start', async () => {
    await run({
      tokenSourceFor: connected,
      start: async () => {
        throw new Error('port in use');
      },
    });
    assert.match(stdout, /::warning::Gitera Cache: the build-tool cache could not start \(port in use\)/);
    assert.equal(process.exitCode, undefined);
  });

  it('turns a refused token into a warning with a hint, and starts nothing', async () => {
    const calls = [];
    await run({
      tokenSourceFor: source(async () => {
        throw new TokenError('Install the app', 'not_installed', 403);
      }),
      start: fakeStart(calls),
    });
    assert.match(stdout, /::warning::Gitera Cache is off for this job \(not_installed\).*GitHub App/);
    assert.equal(calls.length, 0);
    assert.equal(process.exitCode, undefined);
  });

  it('fails the step only for bad inputs, before any network call', async () => {
    process.env.INPUT_TOOLS = 'bazel';
    let called = false;
    await run({
      tokenSourceFor: source(async () => {
        called = true;
      }),
    });
    assert.equal(process.exitCode, 1);
    assert.equal(called, false);
  });

  it('maps the tools input', () => {
    assert.deepEqual(toolsFor('auto'), ['turbo', 'nx']);
    assert.deepEqual(toolsFor('turbo'), ['turbo']);
    assert.deepEqual(toolsFor('none'), []);
  });
});

describe('post step', () => {
  it('stops the server and writes the job summary', async () => {
    process.env.GITHUB_STEP_SUMMARY = path.join(dir, 'summary');
    process.env.STATE_server = JSON.stringify({ port: 4321, pid: 1, secret: 's' });
    await post.run({ stop: async () => ({ hits: 3, misses: 1, uploads: 2, skipped: 0, errors: 0, bytesDown: 3 * 1024 * 1024, bytesUp: 1024 * 1024 }) });
    const summary = read('summary');
    assert.match(summary, /### Gitera Cache/);
    assert.match(summary, /\| 3 \| 1 \| 75% \| 2 \(1\.0 MiB\) \| 3\.0 MiB \|/);
  });

  it('does nothing when no server was started', async () => {
    let called = false;
    await post.run({
      stop: async () => {
        called = true;
      },
    });
    assert.equal(called, false);
  });
});
