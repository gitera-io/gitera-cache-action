'use strict';

// Live round trip against the real Gitera API and bucket, run from CI.
// Uploads a small file and a multipart-sized file under keys unique to the
// run, downloads both, and compares SHA-256. Prints sizes and timings only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../../src/lib/core');
const { TokenSource } = require('../../src/lib/token');
const { CacheClient, cacheKey } = require('../../src/lib/objects');

const MIB = 1024 * 1024;

function writeRandom(file, bytes) {
  const fd = fs.openSync(file, 'w');
  for (let left = bytes; left > 0; left -= 8 * MIB) fs.writeSync(fd, crypto.randomBytes(Math.min(left, 8 * MIB)));
  fs.closeSync(fd);
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const apiUrl = process.env.GITERA_API_URL || 'https://app.gitera.io';
  const tokens = new TokenSource(apiUrl, { onToken: (t) => core.setSecret(t.token) });
  const client = new CacheClient(apiUrl, tokens);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitera-live-'));
  const run = `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  let failed = false;

  for (const [label, size] of [
    ['small', 2048],
    ['multipart', 260 * MIB],
  ]) {
    const src = path.join(dir, `${label}.bin`);
    const out = path.join(dir, `${label}.out`);
    writeRandom(src, size);
    const key = cacheKey('ci-live', `${label}-${run}`);

    const missBefore = await client.download('ci-live', key, out);
    let t = Date.now();
    const stored = await client.upload('ci-live', key, src);
    const upMs = Date.now() - t;
    const again = await client.upload('ci-live', key, src);
    t = Date.now();
    const got = await client.download('ci-live', key, out);
    const downMs = Date.now() - t;
    const match = got === size && sha(src) === sha(out);

    core.info(`${label}: miss before=${missBefore === null} upload=${stored} (${upMs} ms) again=${again} download=${got} bytes (${downMs} ms) match=${match}`);
    if (missBefore !== null || stored !== 'committed' || again !== 'exists' || !match) failed = true;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) core.setFailed('Live round trip did not match');
}

main().catch((error) => core.setFailed(`${error.code ?? 'error'}: ${error.message}`));
