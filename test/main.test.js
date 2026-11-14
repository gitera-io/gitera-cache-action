'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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

describe('folder mode', () => {
  const folderInputs = (extra = {}) =>
    Object.assign(process.env, {
      INPUT_PATH: 'node_modules',
      INPUT_KEY: 'deps-linux-abc',
      'INPUT_RESTORE-KEYS': 'deps-linux-',
      INPUT_TOOLS: 'none',
      ...extra,
    });
  const ops = (calls = []) => ({
    compressionMethod: () => 'zstd',
    folderTool: () => 'folder-0123456789abcdef',
    extractArchive: async (file, method) => calls.push(['extract', method]),
    extractStream: async (input, method) => {
      for await (const _ of input);
      calls.push(['extract-stream', method]);
    },
    resolvePaths: () => ['/ws/node_modules'],
    createArchive: async (paths, file) => {
      calls.push(['create', paths]);
      fs.writeFileSync(file, 'archive');
    },
  });
  const restoring = (hit) => () => ({
    restore: async (tool, name, prefixes, file, { extract } = {}) => {
      assert.equal(tool, 'folder-0123456789abcdef');
      assert.deepEqual(prefixes, ['deps-linux-']);
      if (hit && extract) await extract(Readable.from([Buffer.from('archive')]));
      return hit;
    },
    call: async () => ({ hit }),
  });
  const output = (name) => {
    const match = read('out').match(new RegExp(`${name}<<(\\S+)\\n([\\s\\S]*?)\\n\\1`, 'g'));
    return match ? match[match.length - 1].split('\n')[1] : undefined;
  };

  it('restores the exact key and reports a cache hit', async () => {
    folderInputs();
    const calls = [];
    await run({ tokenSourceFor: connected, clientFor: restoring({ name: 'deps-linux-abc', exact: true, sizeBytes: 1024 }), ops: ops(calls) });
    assert.deepEqual(calls, [['extract-stream', 'zstd']]);
    assert.equal(output('cache-hit'), 'true');
    assert.equal(output('cache-matched-key'), 'deps-linux-abc');
    assert.match(read('state'), /"exact":true/);
  });

  it('restores a restore-keys match as a partial hit', async () => {
    folderInputs();
    await run({ tokenSourceFor: connected, clientFor: restoring({ name: 'deps-linux-old', exact: false, sizeBytes: 1 }), ops: ops() });
    assert.equal(output('cache-hit'), 'false');
    assert.equal(output('cache-matched-key'), 'deps-linux-old');
  });

  it('only looks when lookup-only is set', async () => {
    folderInputs({ 'INPUT_LOOKUP-ONLY': 'true' });
    const calls = [];
    await run({ tokenSourceFor: connected, clientFor: restoring({ name: 'deps-linux-abc', exact: true, sizeBytes: 1 }), ops: ops(calls) });
    assert.deepEqual(calls, []);
    assert.equal(output('cache-hit'), 'true');
  });

  it('fails on a miss only with fail-on-cache-miss', async () => {
    folderInputs();
    await run({ tokenSourceFor: connected, clientFor: restoring(null), ops: ops() });
    assert.equal(process.exitCode, undefined);
    folderInputs({ 'INPUT_FAIL-ON-CACHE-MISS': 'true' });
    await run({ tokenSourceFor: connected, clientFor: restoring(null), ops: ops() });
    assert.equal(process.exitCode, 1);
  });

  it('asks for the folder lookup with the login and hands its result to the restore', async () => {
    folderInputs();
    const asked = [];
    const hit = { name: 'deps-linux-abc', exact: true, url: 'https://bucket/x', sizeBytes: 7 };
    const tokenSourceFor = source(async (options) => {
      asked.push(options);
      return { token: 't', repository: 'acme/web', lookup: { hit } };
    });
    let given;
    const clientFor = () => ({
      restore: async (tool, name, prefixes, file, options) => {
        given = options.first;
        return { name: hit.name, exact: true, sizeBytes: 7 };
      },
    });
    await run({ tokenSourceFor, clientFor, ops: ops() });
    assert.deepEqual(asked, [{ lookup: { tool: 'folder-0123456789abcdef', name: 'deps-linux-abc', prefixes: ['deps-linux-'] } }]);
    assert.deepEqual(given, { hit });
    assert.equal(output('cache-hit'), 'true');
  });

  it('uses the login lookup for lookup-only without another call', async () => {
    folderInputs({ 'INPUT_LOOKUP-ONLY': 'true' });
    const hit = { name: 'deps-linux-abc', exact: true, url: 'https://bucket/x', sizeBytes: 7 };
    const tokenSourceFor = source(async () => ({ token: 't', repository: 'acme/web', lookup: { hit } }));
    const clientFor = () => ({
      call: async () => assert.fail('no separate lookup expected'),
    });
    await run({ tokenSourceFor, clientFor, ops: ops() });
    assert.equal(output('cache-hit'), 'true');
  });

  it('sends no lookup with the login when only Turbo or Nx is used', async () => {
    process.env.INPUT_TOOLS = 'turbo';
    const asked = [];
    const tokenSourceFor = source(async (options) => {
      asked.push(options);
      return { token: 't', repository: 'acme/web' };
    });
    await run({ tokenSourceFor, start: fakeStart() });
    assert.deepEqual(asked, [{}]);
  });

  it('turns a restore failure into a warning and a miss', async () => {
    folderInputs();
    await run({
      tokenSourceFor: connected,
      clientFor: () => ({
        restore: async () => {
          throw Object.assign(new Error('R2 down'), { code: 'network' });
        },
      }),
      ops: ops(),
    });
    assert.match(stdout, /::warning::Gitera Cache: folder restore failed \(network\)/);
    assert.equal(process.exitCode, undefined);
  });

  describe('with the job-start prefetch', () => {
    const TOKEN = { token: 'early', expiresAt: Date.now() + 50 * 60_000, repository: 'acme/web' };
    const TOOL = 'folder-0123456789abcdef';
    /** A fake prefetch whose wait() hands out the given statuses in turn. */
    const prefetched = (statuses, calls = []) => ({
      calls,
      wait: async (options = {}) => {
        calls.push(['wait', Boolean(options.until)]);
        return statuses.length > 1 ? statuses.shift() : statuses[0];
      },
      move: (root) => calls.push(['move', root]),
      discard: () => calls.push(['discard']),
      stop: () => calls.push(['stop']),
    });
    /** A token source that fails if asked to log in, and records what it was given. */
    const reusing = (seen) => (apiUrl, options = {}) => {
      seen.push(options);
      return { refresh: async () => assert.fail('no second login expected') };
    };
    const noRestore = (lookups = []) => () => ({
      call: async (action, body) => {
        lookups.push(body);
        return { hit: null };
      },
      restore: async () => assert.fail('no download expected'),
    });

    it('reuses the login done at job start for the build-tool cache', async () => {
      const seen = [];
      await run({ tokenSourceFor: reusing(seen), start: fakeStart(), prefetch: prefetched([{ state: 'done', token: TOKEN }]) });
      assert.deepEqual(seen, [{ initial: TOKEN }]);
      assert.match(stdout, /::add-mask::early/);
      assert.match(read('state'), /"token":"early"/);
    });

    it('logs in itself when the early token is about to expire', async () => {
      let logins = 0;
      const tokenSourceFor = () => ({ refresh: async () => (logins += 1) && { token: 't', repository: 'acme/web' } });
      const stale = { ...TOKEN, expiresAt: Date.now() + 60_000 };
      await run({ tokenSourceFor, start: fakeStart(), prefetch: prefetched([{ state: 'done', token: stale }]) });
      assert.equal(logins, 1);
    });

    it('moves an exact staged match into place with no API call', async () => {
      folderInputs({ 'INPUT_RESTORE-KEYS': 'deps-linux-' });
      const p = prefetched([{ state: 'done', token: TOKEN, staged: { root: '/stage', tool: TOOL, name: 'deps-linux-abc', sizeBytes: 9 } }]);
      const lookups = [];
      await run({ tokenSourceFor: reusing([]), clientFor: noRestore(lookups), ops: ops(), prefetch: p });
      assert.deepEqual(lookups, []);
      assert.deepEqual(p.calls.filter(([c]) => c === 'move'), [['move', '/stage']]);
      assert.equal(output('cache-hit'), 'true');
      assert.equal(output('cache-matched-key'), 'deps-linux-abc');
      assert.match(read('state'), /"exact":true/);
    });

    it('uses a staged restore-keys match after one lookup confirms it is the best match', async () => {
      folderInputs();
      const p = prefetched([
        { state: 'running', token: TOKEN, speculating: { tool: TOOL, name: 'deps-linux-old', sizeBytes: 9 } },
        { state: 'done', token: TOKEN, staged: { root: '/stage', tool: TOOL, name: 'deps-linux-old', sizeBytes: 9 } },
      ]);
      const lookups = [];
      const clientFor = () => ({
        call: async (action, body) => {
          lookups.push(body);
          return { hit: { name: 'deps-linux-old', exact: false, url: 'https://bucket/x', sizeBytes: 9 } };
        },
        restore: async () => assert.fail('no download expected'),
      });
      await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
      assert.deepEqual(lookups, [{ tool: TOOL, name: 'deps-linux-abc', prefixes: ['deps-linux-'] }]);
      assert.deepEqual(p.calls.filter(([c]) => c === 'move'), [['move', '/stage']]);
      assert.equal(output('cache-hit'), 'false');
      assert.equal(output('cache-matched-key'), 'deps-linux-old');
    });

    it('stops a prefetch of the wrong object and restores the right one', async () => {
      folderInputs();
      const p = prefetched([{ state: 'running', token: TOKEN, speculating: { tool: TOOL, name: 'deps-linux-old', sizeBytes: 9 } }]);
      const right = { name: 'deps-linux-abc', exact: true, url: 'https://bucket/y', sizeBytes: 5 };
      let first;
      const clientFor = () => ({
        call: async () => ({ hit: right }),
        restore: async (tool, name, prefixes, file, options) => {
          first = options.first;
          return { name: right.name, exact: true, sizeBytes: 5 };
        },
      });
      await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
      assert.deepEqual(first, { hit: right });
      assert.ok(p.calls.some(([c]) => c === 'stop'));
      assert.ok(!p.calls.some(([c]) => c === 'move'));
      assert.equal(output('cache-hit'), 'true');
    });

    it('restores normally when the staged object is for other paths', async () => {
      folderInputs();
      const p = prefetched([{ state: 'done', token: TOKEN, staged: { root: '/stage', tool: 'folder-ffffffffffffffff', name: 'deps-linux-abc', sizeBytes: 9 } }]);
      let restored = false;
      const clientFor = () => ({
        call: async () => assert.fail('the restore does its own lookup'),
        restore: async (tool, name, prefixes, file, options) => {
          restored = true;
          assert.equal(options.first, undefined);
          return { name: 'deps-linux-abc', exact: true, sizeBytes: 5 };
        },
      });
      await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
      assert.equal(restored, true);
      assert.ok(!p.calls.some(([c]) => c === 'move'));
    });

    it('takes a miss from the job-start lookup without another call when the key starts with a restore key', async () => {
      folderInputs();
      const p = prefetched([{ state: 'done', token: TOKEN, missed: { tool: TOOL, prefixes: ['deps-linux-'] } }]);
      let first = 'unset';
      const clientFor = () => ({
        call: async () => assert.fail('no lookup expected'),
        restore: async (tool, name, prefixes, file, options) => {
          first = options.first;
          return null;
        },
      });
      await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
      assert.deepEqual(first, { hit: null });
      assert.match(stdout, /no cache found for key deps-linux-abc/);
    });

    for (const [label, missed, inputs] of [
      ['the restore keys changed since job start', { tool: TOOL, prefixes: ['deps-'] }, {}],
      ['the key does not start with a restore key', { tool: TOOL, prefixes: ['deps-linux-'] }, { INPUT_KEY: 'other-abc' }],
      ['the miss was for other paths', { tool: 'folder-ffffffffffffffff', prefixes: ['deps-linux-'] }, {}],
    ]) {
      it(`looks up again when ${label}`, async () => {
        folderInputs(inputs);
        const p = prefetched([{ state: 'done', token: TOKEN, missed }]);
        let first = 'unset';
        const clientFor = () => ({
          restore: async (tool, name, prefixes, file, options) => {
            first = options.first;
            return null;
          },
        });
        await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
        assert.equal(first, undefined);
      });
    }

    it('cleans up the prefetch in every case', async () => {
      folderInputs();
      const p = prefetched([{ state: 'done', token: TOKEN }]);
      await run({ tokenSourceFor: reusing([]), clientFor: () => ({ restore: async () => null }), ops: ops(), prefetch: p });
      assert.ok(p.calls.some(([c]) => c === 'discard'));
    });

    it('falls back to a normal restore when the move fails', async () => {
      folderInputs();
      const p = prefetched([{ state: 'done', token: TOKEN, staged: { root: '/stage', tool: TOOL, name: 'deps-linux-abc', sizeBytes: 9 } }]);
      p.move = () => {
        throw new Error('EACCES');
      };
      let restored = false;
      const clientFor = () => ({
        restore: async () => {
          restored = true;
          return { name: 'deps-linux-abc', exact: true, sizeBytes: 5 };
        },
      });
      await run({ tokenSourceFor: reusing([]), clientFor, ops: ops(), prefetch: p });
      assert.equal(restored, true);
      assert.equal(output('cache-hit'), 'true');
    });
  });

  describe('post step save', () => {
    const setState = (folderState, folder = { paths: ['node_modules'], key: 'deps-linux-abc', restoreKeys: [], lookupOnly: false }) => {
      process.env.STATE_inputs = JSON.stringify({ folder, tools: 'none', apiUrl: 'https://app.gitera.io' });
      process.env.STATE_folder = JSON.stringify({ tool: 'folder-0123456789abcdef', method: 'zstd', key: 'deps-linux-abc', exact: false, matched: '', ...folderState });
    };
    afterEach(() => {
      delete process.env.STATE_inputs;
      delete process.env.STATE_folder;
    });

    it('archives the paths and uploads them under the key with its name', async () => {
      setState({});
      const calls = [];
      const uploads = [];
      await post.run({
        clientFor: () => ({ upload: async (tool, key, file, opts) => uploads.push({ tool, key, opts }) && 'committed' }),
        ops: ops(calls),
      });
      assert.deepEqual(calls, [['create', ['/ws/node_modules']]]);
      assert.equal(uploads[0].tool, 'folder-0123456789abcdef');
      assert.deepEqual(uploads[0].opts, { name: 'deps-linux-abc' });
      assert.match(uploads[0].key, /^[0-9a-f]{64}$/);
      assert.match(stdout, /saved key deps-linux-abc/);
    });

    it('does not save after an exact hit', async () => {
      setState({ exact: true });
      let uploaded = false;
      await post.run({ clientFor: () => ({ upload: async () => (uploaded = true) }), ops: ops() });
      assert.equal(uploaded, false);
    });

    it('turns a save failure into a warning', async () => {
      setState({});
      await post.run({
        clientFor: () => ({
          upload: async () => {
            throw Object.assign(new Error('full'), { code: 'quota_exceeded' });
          },
        }),
        ops: ops(),
      });
      assert.match(stdout, /::warning::Gitera Cache: folder save failed \(quota_exceeded\)/);
      assert.equal(process.exitCode, undefined);
    });

    const MIB = 1024 * 1024;
    const streamOps = (bound, calls = []) => ({ ...ops(calls), archiveBound: () => bound });

    it('uploads while packing when the archive may be over 32 MiB', async () => {
      setState({});
      const calls = [];
      const streamed = [];
      await post.run({
        clientFor: () => ({
          uploadStream: async (tool, key, file, opts) => {
            streamed.push({ tool, opts });
            await opts.packed;
            assert.equal(fs.readFileSync(file, 'utf8'), 'archive');
            return 'committed';
          },
          upload: async () => assert.fail('no plain upload expected'),
        }),
        ops: streamOps(200 * MIB, calls),
      });
      assert.equal(streamed[0].tool, 'folder-0123456789abcdef');
      assert.equal(streamed[0].opts.name, 'deps-linux-abc');
      assert.equal(streamed[0].opts.maxSizeBytes, 200 * MIB);
      assert.deepEqual(calls, [['create', ['/ws/node_modules']]]);
      assert.match(stdout, /pack and upload \d+ ms/);
      assert.match(stdout, /saved key deps-linux-abc/);
    });

    for (const [label, status] of [
      ['a server without streaming', 400],
      ['a bound over the object limit', 413],
      ['a bound over the quota', 507],
    ]) {
      it(`packs first and uploads the old way after ${label}`, async () => {
        setState({});
        let uploaded = false;
        await post.run({
          clientFor: () => ({
            uploadStream: async () => {
              throw Object.assign(new Error('refused'), { code: 'x', status });
            },
            upload: async (tool, key, file) => {
              assert.equal(fs.readFileSync(file, 'utf8'), 'archive');
              uploaded = true;
              return 'committed';
            },
          }),
          ops: streamOps(200 * MIB),
        });
        assert.equal(uploaded, true);
        assert.match(stdout, /saved key deps-linux-abc/);
      });
    }

    it('keeps the plain upload for archives that fit one PUT', async () => {
      setState({});
      let uploaded = false;
      await post.run({
        clientFor: () => ({
          uploadStream: async () => assert.fail('no stream expected'),
          upload: async () => (uploaded = true) && 'committed',
        }),
        ops: streamOps(10 * MIB),
      });
      assert.equal(uploaded, true);
    });
  });
});
