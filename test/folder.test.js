'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { resolvePaths, folderTool, createArchive, extractArchive, compressionMethod } = require('../src/lib/folder');

let root;
let home;
let workspace;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-folder-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'ws');
  for (const dir of [home, workspace]) fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('resolvePaths', () => {
  it('expands ~, workspace-relative paths, globs and negations like actions/cache', () => {
    write(path.join(home, '.cache/pip/a.whl'), 'a');
    write(path.join(workspace, 'node_modules/x/index.js'), 'x');
    write(path.join(workspace, 'packages/a/dist/a.js'), 'a');
    write(path.join(workspace, 'packages/b/dist/b.js'), 'b');
    write(path.join(workspace, 'packages/b/dist/b.map'), 'm');

    const paths = resolvePaths(['~/.cache/pip', 'node_modules', 'packages/*/dist/**', '!**/*.map', 'missing-dir'], { workspace, home });
    assert.deepEqual(paths, [
      path.join(home, '.cache/pip'),
      path.join(workspace, 'node_modules'),
      path.join(workspace, 'packages/a/dist'),
      path.join(workspace, 'packages/a/dist/a.js'),
      path.join(workspace, 'packages/b/dist'),
      path.join(workspace, 'packages/b/dist/b.js'),
    ]);
  });

  it('returns nothing when no path exists', () => {
    assert.deepEqual(resolvePaths(['nope', 'also/*'], { workspace, home }), []);
  });
});

describe('folderTool', () => {
  it('depends on the paths, the compression and the platform, not their order of whitespace', () => {
    const a = folderTool(['node_modules', '~/.npm'], 'zstd');
    assert.match(a, /^folder-[0-9a-f]{16}$/);
    assert.equal(a, folderTool(['node_modules', '~/.npm'], 'zstd'));
    assert.notEqual(a, folderTool(['node_modules'], 'zstd'));
    assert.notEqual(a, folderTool(['node_modules', '~/.npm'], 'gzip'));
  });
});

describe('createArchive and extractArchive', () => {
  for (const method of ['zstd', 'gzip']) {
    it(`round-trips files and folders with ${method}`, async (t) => {
      if (method === 'zstd' && compressionMethod() !== 'zstd') return t.skip('zstd not installed');
      write(path.join(workspace, 'node_modules/x/index.js'), 'module x');
      write(path.join(home, '.cache/tool/data.bin'), 'cached data');
      const paths = resolvePaths(['node_modules', '~/.cache/tool'], { workspace, home });
      const archive = path.join(root, `cache.${method}`);
      await createArchive(paths, archive, method);
      assert.ok(fs.statSync(archive).size > 0);

      fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true });
      fs.rmSync(path.join(home, '.cache'), { recursive: true });
      await extractArchive(archive, method);
      assert.equal(fs.readFileSync(path.join(workspace, 'node_modules/x/index.js'), 'utf8'), 'module x');
      assert.equal(fs.readFileSync(path.join(home, '.cache/tool/data.bin'), 'utf8'), 'cached data');
    });
  }

  it('reports a broken archive', async () => {
    const bad = path.join(root, 'bad.gzip');
    fs.writeFileSync(bad, 'not an archive');
    await assert.rejects(extractArchive(bad, 'gzip'));
  });

  it('refuses to create an empty archive', async () => {
    await assert.rejects(createArchive([], path.join(root, 'x'), 'gzip'), /nothing to cache/);
  });
});
