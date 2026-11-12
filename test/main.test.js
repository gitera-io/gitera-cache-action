'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { run } = require('../src/main');
const { TokenError } = require('../src/lib/token');

let dir;
let stdout;
const realWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-main-'));
  process.env.GITHUB_OUTPUT = path.join(dir, 'out');
  process.env.GITHUB_STATE = path.join(dir, 'state');
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
  delete process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_STATE;
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const read = (file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '');
const source = (refresh) => () => ({ refresh });

describe('main step', () => {
  it('connects and reports the repository', async () => {
    await run({ tokenSourceFor: source(async () => ({ token: 't', repository: 'acme/web' })) });
    assert.match(stdout, /connected for acme\/web/);
    assert.equal(process.exitCode, undefined);
    assert.match(read('out'), /cache-hit<<[\s\S]*false/);
  });

  it('turns a refused token into a warning with a hint, and does not fail the step', async () => {
    await run({
      tokenSourceFor: source(async () => {
        throw new TokenError('Install the app', 'not_installed', 403);
      }),
    });
    assert.match(stdout, /::warning::Gitera Cache is off for this job \(not_installed\).*GitHub App/);
    assert.equal(process.exitCode, undefined);
    assert.match(read('state'), /disabled<<[\s\S]*not_installed/);
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
});
