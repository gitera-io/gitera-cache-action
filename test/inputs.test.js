'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const { readInputs, InputError, MAX_KEY_LENGTH } = require('../src/lib/inputs');

const setInputs = (inputs) => {
  for (const [name, value] of Object.entries(inputs)) process.env[`INPUT_${name.toUpperCase()}`] = value;
};

afterEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('INPUT_')) delete process.env[name];
});

describe('readInputs', () => {
  it('defaults to the build-tool cache only', () => {
    assert.deepEqual(readInputs(), { folder: null, tools: 'auto', apiUrl: 'https://app.gitera.io' });
  });

  it('reads folder mode like actions/cache', () => {
    setInputs({
      path: 'node_modules\n  ~/.cache/pip  \n\n',
      key: 'deps-linux-abc',
      'restore-keys': 'deps-linux-\ndeps-',
      'lookup-only': 'true',
      tools: 'none',
    });
    assert.deepEqual(readInputs().folder, {
      paths: ['node_modules', '~/.cache/pip'],
      key: 'deps-linux-abc',
      restoreKeys: ['deps-linux-', 'deps-'],
      lookupOnly: true,
      failOnCacheMiss: false,
    });
  });

  it('keeps only the origin of api-url', () => {
    setInputs({ 'api-url': 'https://app.gitera.io/some/path?x=1' });
    assert.equal(readInputs().apiUrl, 'https://app.gitera.io');
  });

  for (const [label, inputs] of [
    ['path without key', { path: 'dist' }],
    ['key without path', { key: 'k' }],
    ['restore-keys without path', { 'restore-keys': 'k-' }],
    ['nothing to do', { tools: 'none' }],
    ['an unknown tool', { tools: 'bazel' }],
    ['a plain-http api-url', { 'api-url': 'http://app.gitera.io' }],
    ['a bad api-url', { 'api-url': 'not a url' }],
    ['a key with a comma', { path: 'dist', key: 'a,b' }],
    ['a key that is too long', { path: 'dist', key: 'k'.repeat(MAX_KEY_LENGTH + 1) }],
    ['a bad boolean', { path: 'dist', key: 'k', 'lookup-only': 'yes' }],
  ]) {
    it(`refuses ${label}`, () => {
      setInputs(inputs);
      assert.throws(() => readInputs(), (error) => error instanceof InputError || /must be true or false/.test(error.message));
    });
  }

  it('allows a local http api-url for development', () => {
    setInputs({ 'api-url': 'http://127.0.0.1:3000' });
    assert.equal(readInputs().apiUrl, 'http://127.0.0.1:3000');
  });
});
