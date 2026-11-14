'use strict';

/**
 * Folder mode: which paths to cache, and the archive that holds them.
 *
 * Paths follow actions/cache: one per line, `~` for the home folder, paths
 * relative to the workspace, globs, and `!pattern` to leave matches out.
 * The archive is `tar` with absolute paths (`-P`), compressed with zstd when
 * it is installed, else gzip, so a restore puts files back where they were.
 *
 * The tool name sent to Gitera includes a hash of the paths, the compression
 * and the platform, so caches made with other paths or another OS never mix
 * (like the "version" actions/cache adds to every key).
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expand(pattern, { workspace, home }) {
  const p = pattern.trim();
  if (p === '~' || p.startsWith('~/')) return path.join(home, p.slice(1));
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

/** Absolute, existing, sorted, de-duplicated paths for the `path` input. */
function resolvePaths(patterns, { workspace = process.env.GITHUB_WORKSPACE || process.cwd(), home = os.homedir() } = {}) {
  const include = [];
  const exclude = [];
  for (const raw of patterns) {
    if (!raw.trim()) continue;
    if (raw.trim().startsWith('!')) exclude.push(raw.trim().slice(1));
    else include.push(raw);
  }
  const excluded = (file) =>
    exclude.some((pattern) => path.matchesGlob(file, expand(pattern, { workspace, home })) || path.matchesGlob(file, pattern));

  const found = new Set();
  for (const pattern of include) {
    const abs = expand(pattern, { workspace, home });
    if (!/[*?[{]/.test(abs)) {
      if (fs.existsSync(abs) && !excluded(abs)) found.add(abs);
      continue;
    }
    for (const match of fs.globSync(abs)) {
      const full = path.resolve(match);
      if (!excluded(full)) found.add(full);
    }
  }
  return [...found].sort();
}

/**
 * zstd level for saving. Measured on ubuntu-latest (2 cores) with a 462 MB
 * node_modules tar: -3 gives 99 MB in 1.4-2.1 s, -6 gives 90 MB in 2.4-3.2 s,
 * -9 gives 83 MB in 4-5 s. Uploads run at ~27 MB/s and overlap packing, so
 * -6 is the smallest archive that still packs faster than it uploads.
 * Restores read any level.
 */
const ZSTD_LEVEL = 6;

/** zstd when the runner has it, else gzip. */
function compressionMethod() {
  return spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0 ? 'zstd' : 'gzip';
}

/** `folder-<16 hex>`: one cache space per path list, compression and platform. */
function folderTool(patterns, method, platform = process.platform) {
  const version = crypto
    .createHash('sha256')
    .update([...patterns.map((p) => p.trim()), method, platform].join('\n'))
    .digest('hex');
  return `folder-${version.slice(0, 16)}`;
}

/**
 * An upper bound on the archive createArchive makes from `paths`, without
 * packing: every tar header and data block, a long-name header per entry,
 * then 1% and 1 MiB on top for zstd or gzip frames on data that does not
 * compress. Symlinks are not followed, as in tar.
 */
function archiveBound(paths) {
  const BLOCK = 512;
  const blocks = (bytes) => Math.ceil(bytes / BLOCK) * BLOCK;
  let total = 20 * BLOCK; // end-of-archive blocks and record padding
  const visit = (file) => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return;
    }
    // Header, plus a long-name (or pax) header and its name blocks.
    total += 2 * BLOCK + blocks(Buffer.byteLength(file) + 1);
    if (stat.isFile()) total += blocks(stat.size);
    else if (stat.isSymbolicLink()) total += blocks(Buffer.byteLength(fs.readlinkSync(file)) + 1);
    else if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  };
  for (const p of paths) visit(p);
  return Math.ceil(total * 1.01) + 1024 * 1024;
}

/** Writes `paths` into a compressed tar at `archivePath`. */
async function createArchive(paths, archivePath, method) {
  if (paths.length === 0) throw new Error('nothing to cache: no path matched');
  const list = `${archivePath}.files`;
  // NUL-separated, so names with spaces or newlines are safe.
  fs.writeFileSync(list, `${paths.join('\0')}\0`);
  try {
    const tarArgs = ['--null', '-P', '-c', '-f', '-', '-T', list];
    const compress = method === 'zstd' ? ['zstd', ['-T0', `-${ZSTD_LEVEL}`, '-q', '-o', archivePath, '-']] : ['gzip', ['-c']];
    const out = method === 'zstd' ? null : fs.createWriteStream(archivePath);
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const packer = spawn(compress[0], compress[1], { stdio: ['pipe', out ? 'pipe' : 'ignore', 'pipe'] });
      let failed = false;
      const fail = (error) => {
        if (!failed) {
          failed = true;
          reject(error);
        }
      };
      let tarErr = '';
      tar.stderr.on('data', (c) => (tarErr += c));
      packer.stderr.on('data', () => {});
      tar.stdout.pipe(packer.stdin);
      if (out) packer.stdout.pipe(out);
      tar.on('error', fail);
      packer.on('error', fail);
      let done = 0;
      const finish = () => {
        done += 1;
        if (done === (out ? 3 : 2) && !failed) resolve();
      };
      tar.on('close', (code) => (code === 0 ? finish() : fail(new Error(`tar exited ${code}: ${tarErr.trim().slice(-500)}`))));
      packer.on('close', (code) => (code === 0 ? finish() : fail(new Error(`${compress[0]} exited ${code}`))));
      if (out) out.on('finish', finish);
    });
  } finally {
    fs.rmSync(list, { force: true });
  }
}

/** Unpacks an archive made by createArchive back to its absolute paths. */
function extractArchive(archivePath, method) {
  return unpack(method, archivePath, null);
}

/**
 * Same as extractArchive, but reads the archive from `input` as it arrives,
 * so unpacking can run while the download is still going. If `input` fails,
 * the unpackers are stopped and the promise rejects with its error.
 *
 * With `root`, the absolute paths are unpacked under `root` instead of `/`
 * (tar drops the leading `/`), so a prefetch can stage them first.
 */
function extractStream(input, method, { root } = {}) {
  return unpack(method, null, input, root);
}

function unpack(method, archivePath, input, root) {
  const source = archivePath ? [archivePath] : [];
  const decompress = method === 'zstd' ? ['zstd', ['-d', '-q', '-c', ...source]] : ['gzip', ['-d', '-c', ...source]];
  const tarArgs = root ? ['-x', '-f', '-'] : ['-P', '-x', '-f', '-'];
  return new Promise((resolve, reject) => {
    const unpacker = spawn(decompress[0], decompress[1], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', tarArgs, { cwd: root ?? '/', stdio: ['pipe', 'ignore', 'pipe'] });
    let failed = false;
    const fail = (error) => {
      if (!failed) {
        failed = true;
        unpacker.kill();
        tar.kill();
        reject(error);
      }
    };
    let errors = '';
    unpacker.stderr.on('data', (c) => (errors += c));
    tar.stderr.on('data', (c) => (errors += c));
    if (input) {
      input.on('error', fail);
      // A child that exits early closes its stdin; its exit code reports why.
      unpacker.stdin.on('error', () => {});
      input.pipe(unpacker.stdin);
    }
    tar.stdin.on('error', () => {});
    unpacker.stdout.pipe(tar.stdin);
    unpacker.on('error', fail);
    tar.on('error', fail);
    let done = 0;
    const finish = () => {
      done += 1;
      if (done === 2 && !failed) resolve();
    };
    unpacker.on('close', (code) => (code === 0 ? finish() : fail(new Error(`${decompress[0]} exited ${code}: ${errors.trim().slice(-500)}`))));
    tar.on('close', (code) => (code === 0 ? finish() : fail(new Error(`tar exited ${code}: ${errors.trim().slice(-500)}`))));
  });
}

module.exports = { resolvePaths, compressionMethod, folderTool, createArchive, extractArchive, extractStream, archiveBound, ZSTD_LEVEL };
