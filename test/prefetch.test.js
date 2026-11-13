'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { writeStatus, readStatus, waitForPrefetch, moveInto, discard, statusPath } = require('../src/lib/prefetch');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-prefetch-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('status file', () => {
  it('round-trips and is readable by its owner only', () => {
    writeStatus(root, { state: 'done', token: { token: 't', expiresAt: 1 } });
    assert.deepEqual(readStatus(root), { state: 'done', token: { token: 't', expiresAt: 1 } });
    assert.equal(fs.statSync(statusPath(root)).mode & 0o077, 0);
  });

  it('reads as null when there is none or it is broken', () => {
    assert.equal(readStatus(root), null);
    fs.writeFileSync(statusPath(root), '{nope');
    assert.equal(readStatus(root), null);
  });
});

describe('waitForPrefetch', () => {
  it('returns null at once when no prefetch ran', async () => {
    assert.equal(await waitForPrefetch(root), null);
  });

  it('waits for a running prefetch to finish', async () => {
    writeStatus(root, { state: 'running', pid: process.pid });
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 3) writeStatus(root, { state: 'done', pid: process.pid, staged: null });
    };
    assert.deepEqual(await waitForPrefetch(root, { sleep }), { state: 'done', pid: process.pid, staged: null });
    assert.equal(polls, 3);
  });

  it('stops waiting early when the condition holds', async () => {
    writeStatus(root, { state: 'running', pid: process.pid, token: { token: 't' }, speculating: { name: 'deps-1' } });
    const status = await waitForPrefetch(root, { until: (s) => Boolean(s.speculating), sleep: async () => assert.fail('no wait') });
    assert.equal(status.speculating.name, 'deps-1');
    assert.equal(status.state, 'running');
  });

  it('gives up on a prefetch whose process is gone', async () => {
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => child.on('exit', resolve));
    writeStatus(root, { state: 'running', pid: child.pid, token: { token: 't', expiresAt: 9 } });
    const status = await waitForPrefetch(root, { sleep: async () => {} });
    assert.equal(status.state, 'abandoned');
    assert.deepEqual(status.token, { token: 't', expiresAt: 9 });
  });

  it('stops a prefetch that runs past the timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    try {
      writeStatus(root, { state: 'running', pid: child.pid });
      let t = 0;
      const exited = new Promise((resolve) => child.on('exit', resolve));
      const status = await waitForPrefetch(root, { timeoutMs: 100, now: () => (t += 60), sleep: async () => {} });
      assert.equal(status.state, 'abandoned');
      await exited;
    } finally {
      child.kill();
    }
  });
});

describe('moveInto', () => {
  it('moves a missing folder in one go and merges into existing ones', () => {
    const staging = path.join(root, 'staging');
    const dest = path.join(root, 'dest');
    write(path.join(staging, 'ws/bench/node_modules/x/index.js'), 'x');
    write(path.join(staging, 'ws/bench/node_modules/.bin/keep'), 'b');
    fs.symlinkSync('../x/index.js', path.join(staging, 'ws/bench/node_modules/.bin/x'));
    write(path.join(staging, 'home/.cache/tool/a'), 'new');
    write(path.join(dest, 'ws/bench/package.json'), '{}');
    write(path.join(dest, 'home/.cache/tool/a'), 'old');
    write(path.join(dest, 'home/.cache/tool/other'), 'kept');

    moveInto(staging, dest);

    assert.equal(fs.readFileSync(path.join(dest, 'ws/bench/node_modules/x/index.js'), 'utf8'), 'x');
    assert.equal(fs.readlinkSync(path.join(dest, 'ws/bench/node_modules/.bin/x')), '../x/index.js');
    assert.equal(fs.readFileSync(path.join(dest, 'ws/bench/package.json'), 'utf8'), '{}');
    assert.equal(fs.readFileSync(path.join(dest, 'home/.cache/tool/a'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dest, 'home/.cache/tool/other'), 'utf8'), 'kept');
    assert.equal(fs.existsSync(path.join(staging, 'ws/bench/node_modules')), false);
  });

  it('replaces a file with a folder of the same name', () => {
    const staging = path.join(root, 'staging');
    const dest = path.join(root, 'dest');
    write(path.join(staging, 'out/a/b'), 'deep');
    write(path.join(dest, 'out/a'), 'was a file');
    moveInto(staging, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'out/a/b'), 'utf8'), 'deep');
  });
});

describe('discard', () => {
  it('removes the staged folder and the status file', () => {
    const staged = path.join(root, 'staging');
    write(path.join(staged, 'a'), 'x');
    writeStatus(root, { state: 'done', staged: { root: staged } });
    discard(root, readStatus(root));
    assert.equal(fs.existsSync(staged), false);
    assert.equal(readStatus(root), null);
  });
});
