'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { prefetch } = require('../src/prefetch-process');
const { readStatus } = require('../src/lib/prefetch');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-prefetch-process-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (name.startsWith('INPUT_')) delete process.env[name];
});

const TOKEN = { token: 'early', expiresAt: 123, repository: 'acme/web' };
const ops = (calls = []) => ({
  compressionMethod: () => 'zstd',
  folderTool: () => 'folder-0123456789abcdef',
  extractStream: async (input, method, options) => calls.push(['extract', method, options]),
});
const login = (asked, extra = {}) => () => ({
  refresh: async (options) => {
    asked.push(options);
    return { ...TOKEN, ...extra };
  },
});

describe('prefetch process', () => {
  it('logs in only when there is no folder cache', async () => {
    const asked = [];
    const status = await prefetch({ dir, tokenSourceFor: login(asked), ops: ops() });
    assert.equal(status.state, 'done');
    assert.deepEqual(status.token, TOKEN);
    assert.deepEqual(asked, [{}]);
    assert.deepEqual(readStatus(dir).token, TOKEN);
  });

  it('logs in only when the key is still empty at job start', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: '', 'INPUT_RESTORE-KEYS': 'deps-' });
    const asked = [];
    const status = await prefetch({ dir, tokenSourceFor: login(asked), ops: ops() });
    assert.equal(status.state, 'done');
    assert.deepEqual(asked, [{}]);
  });

  it('does not log in against an api-url it cannot check', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: '', 'INPUT_API-URL': 'http://evil.example' });
    const status = await prefetch({ dir, tokenSourceFor: () => assert.fail('no login'), ops: ops() });
    assert.equal(status.state, 'failed');
  });

  it('stages the best restore-keys match under its own root', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: 'deps-', 'INPUT_RESTORE-KEYS': 'deps-' });
    const asked = [];
    const hit = { name: 'deps-abc', exact: false, url: 'https://bucket/x', sizeBytes: 9 };
    const calls = [];
    let seenFirst;
    const clientFor = () => ({
      restore: async (tool, name, prefixes, file, options) => {
        seenFirst = options.first;
        await options.extract('stream');
        return { name: hit.name, exact: false, sizeBytes: 9 };
      },
    });
    const status = await prefetch({ dir, tokenSourceFor: login(asked, { lookup: { hit } }), clientFor, ops: ops(calls) });
    assert.deepEqual(asked, [{ lookup: { tool: 'folder-0123456789abcdef', name: 'deps-', prefixes: ['deps-'] } }]);
    assert.deepEqual(seenFirst, { hit });
    assert.equal(status.state, 'done');
    assert.equal(status.speculating.name, 'deps-abc');
    assert.equal(status.staged.name, 'deps-abc');
    assert.equal(status.staged.tool, 'folder-0123456789abcdef');
    assert.equal(calls[0][2].root, status.staged.root);
    assert.ok(status.staged.root.startsWith(dir));
  });

  it('does not download without restore-keys, or when the lookup misses', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: 'deps-' });
    const clientFor = () => ({ restore: async () => assert.fail('no download') });
    let status = await prefetch({ dir, tokenSourceFor: login([]), clientFor, ops: ops() });
    assert.equal(status.staged, undefined);
    process.env['INPUT_RESTORE-KEYS'] = 'deps-';
    status = await prefetch({ dir, tokenSourceFor: login([], { lookup: { hit: null } }), clientFor, ops: ops() });
    assert.equal(status.staged, undefined);
    assert.equal(status.state, 'done');
  });

  it('records a definite miss with the cache space and prefixes it was for', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: 'deps-', 'INPUT_RESTORE-KEYS': 'deps-linux-\ndeps-' });
    const status = await prefetch({ dir, tokenSourceFor: login([], { lookup: { hit: null } }), ops: ops() });
    assert.deepEqual(status.missed, { tool: 'folder-0123456789abcdef', prefixes: ['deps-linux-', 'deps-'] });
  });

  it('claims no miss when the server did not run the lookup', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: 'deps-', 'INPUT_RESTORE-KEYS': 'deps-' });
    const status = await prefetch({ dir, tokenSourceFor: login([]), ops: ops() });
    assert.equal(status.missed, undefined);
  });

  it('keeps the token when the download fails, and cleans the staging folder', async () => {
    Object.assign(process.env, { INPUT_PATH: 'node_modules', INPUT_KEY: 'deps-', 'INPUT_RESTORE-KEYS': 'deps-' });
    const hit = { name: 'deps-abc', exact: false, url: 'https://bucket/x', sizeBytes: 9 };
    const clientFor = () => ({
      restore: async () => {
        throw Object.assign(new Error('R2 down'), { code: 'network' });
      },
    });
    const status = await prefetch({ dir, tokenSourceFor: login([], { lookup: { hit } }), clientFor, ops: ops() });
    assert.equal(status.state, 'done');
    assert.equal(status.restoreError, 'network');
    assert.equal(status.staged, undefined);
    assert.deepEqual(status.token, TOKEN);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('staging-')), []);
  });

  it('reports a refused login as failed, without throwing', async () => {
    const tokenSourceFor = () => ({
      refresh: async () => {
        throw Object.assign(new Error('no'), { code: 'not_installed' });
      },
    });
    const status = await prefetch({ dir, tokenSourceFor, ops: ops() });
    assert.equal(status.state, 'failed');
    assert.equal(status.error, 'not_installed');
    assert.equal(status.token, undefined);
  });
});
