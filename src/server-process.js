'use strict';

/**
 * Background process that runs the local build-tool cache server for the rest
 * of the job. Started detached by the main step; the post step flushes it and
 * stops it. Settings come from the environment, so the secret never shows in
 * a process list.
 *
 *   GITERA_CACHE_API_URL     Gitera origin
 *   GITERA_CACHE_SECRET      bearer secret the build tools send
 *   GITERA_CACHE_TOOLS       comma-separated: turbo,nx
 *   GITERA_CACHE_READY_FILE  where to write {"port","pid"} once listening
 */

const fs = require('node:fs');

const { TokenSource } = require('./lib/token');
const { CacheClient } = require('./lib/objects');
const { createCacheServer } = require('./lib/server');

const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

function main() {
  const { GITERA_CACHE_API_URL: apiUrl, GITERA_CACHE_SECRET: secret, GITERA_CACHE_TOOLS: tools, GITERA_CACHE_READY_FILE: readyFile } = process.env;
  if (!apiUrl || !secret || !tools || !readyFile) throw new Error('missing settings');
  delete process.env.GITERA_CACHE_SECRET;

  const client = new CacheClient(apiUrl, new TokenSource(apiUrl));
  const { server } = createCacheServer({ client, secret, tools: tools.split(','), tmpDir: process.env.RUNNER_TEMP, log });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(readyFile, JSON.stringify({ port: server.address().port, pid: process.pid }));
    log(`listening on 127.0.0.1:${server.address().port} for ${tools}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

try {
  main();
} catch (error) {
  log(`cannot start: ${error.message}`);
  process.exit(1);
}
