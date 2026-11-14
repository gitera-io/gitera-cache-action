'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { resolvePaths, folderTool, createArchive, extractArchive, extractStream, compressionMethod, archiveBound, ZSTD_LEVEL } = require('../src/lib/folder');
const { moveInto } = require('../src/lib/prefetch');

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

  it(`packs zstd at level ${ZSTD_LEVEL}`, async (t) => {
    if (compressionMethod() !== 'zstd') return t.skip('zstd not installed');
    // Text where zstd levels give different output.
    const words = Array.from({ length: 20_000 }, (_, i) => `token${(i * 7919) % 5003} value${(i * 104729) % 997}`).join(' ');
    write(path.join(workspace, 'node_modules/x/data.txt'), words);
    const paths = resolvePaths(['node_modules'], { workspace, home });
    const archive = path.join(root, 'level.zst');
    await createArchive(paths, archive, 'zstd');
    // The same tar stream createArchive makes, compressed by hand at each level.
    const list = path.join(root, 'list');
    fs.writeFileSync(list, `${paths.join('\0')}\0`);
    const tar = spawnSync('tar', ['--null', '-P', '-c', '-f', '-', '-T', list]).stdout;
    const at = (level) => spawnSync('zstd', ['-T0', `-${level}`, '-c', '-q'], { input: tar }).stdout.length;
    assert.notEqual(at(ZSTD_LEVEL), at(ZSTD_LEVEL + 3));
    assert.equal(fs.statSync(archive).size, at(ZSTD_LEVEL));
    fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true });
    await extractArchive(archive, 'zstd');
    assert.equal(fs.readFileSync(path.join(workspace, 'node_modules/x/data.txt'), 'utf8'), words);
  });

  for (const method of ['zstd', 'gzip']) {
    it(`unpacks from a stream that arrives in small pieces with ${method}`, async (t) => {
      if (method === 'zstd' && compressionMethod() !== 'zstd') return t.skip('zstd not installed');
      write(path.join(workspace, 'node_modules/x/index.js'), 'module x'.repeat(5000));
      const archive = path.join(root, `cache.${method}`);
      await createArchive(resolvePaths(['node_modules'], { workspace, home }), archive, method);
      fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true });

      const bytes = fs.readFileSync(archive);
      const input = Readable.from(
        (async function* () {
          for (let i = 0; i < bytes.length; i += 97) {
            await new Promise((resolve) => setImmediate(resolve));
            yield bytes.subarray(i, i + 97);
          }
        })()
      );
      await extractStream(input, method);
      assert.equal(fs.readFileSync(path.join(workspace, 'node_modules/x/index.js'), 'utf8'), 'module x'.repeat(5000));
    });
  }

  it('rejects when the input stream fails, and stops the unpacker', async () => {
    const input = new PassThrough();
    const done = extractStream(input, 'gzip');
    input.write(Buffer.from([0x1f, 0x8b]));
    input.destroy(new Error('range 3 failed'));
    await assert.rejects(done, /range 3 failed/);
  });

  it('stages an archive under a root, and moveInto puts it back in place', async () => {
    write(path.join(workspace, 'node_modules/x/index.js'), 'module x');
    const archive = path.join(root, 'cache.gzip');
    await createArchive(resolvePaths(['node_modules'], { workspace, home }), archive, 'gzip');
    fs.rmSync(path.join(workspace, 'node_modules'), { recursive: true });

    const staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    await extractStream(fs.createReadStream(archive), 'gzip', { root: staging });
    assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false, 'nothing lands in place before the move');
    assert.equal(fs.readFileSync(path.join(staging, workspace, 'node_modules/x/index.js'), 'utf8'), 'module x');

    moveInto(staging, '/');
    assert.equal(fs.readFileSync(path.join(workspace, 'node_modules/x/index.js'), 'utf8'), 'module x');
  });

  it('refuses to create an empty archive', async () => {
    await assert.rejects(createArchive([], path.join(root, 'x'), 'gzip'), /nothing to cache/);
  });

  for (const method of ['zstd', 'gzip']) {
    it(`bounds the ${method} archive size from above, even for data that does not compress`, async (t) => {
      if (method === 'zstd' && compressionMethod() !== 'zstd') return t.skip('zstd not installed');
      write(path.join(workspace, 'node_modules/a/random.bin'), crypto.randomBytes(300_000));
      write(path.join(workspace, 'node_modules/a/text.js'), 'x'.repeat(100_000));
      for (let i = 0; i < 50; i += 1) write(path.join(workspace, `node_modules/many/${'n'.repeat(120)}-${i}.js`), `${i}`);
      fs.symlinkSync('a/text.js', path.join(workspace, 'node_modules/link.js'));
      const paths = resolvePaths(['node_modules'], { workspace, home });
      const archive = path.join(root, `bound.${method}`);
      await createArchive(paths, archive, method);
      const bound = archiveBound(paths);
      assert.ok(bound >= fs.statSync(archive).size, `${bound} >= ${fs.statSync(archive).size}`);
      assert.ok(bound < 400_000 + 100_000 + 3 * 1024 * 1024, 'not wildly above the input');
    });
  }
});
