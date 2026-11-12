'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, beforeEach, describe, it } = require('node:test');

const { TokenSource, TokenError, requestOidcToken, exchangeToken, REFRESH_MARGIN_MS, MAX_ATTEMPTS } = require('../src/lib/token');

// One local server plays both the runner's OIDC endpoint and the Gitera API.
let server;
let base;
let script;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const route = req.url.startsWith('/oidc') ? 'oidc' : req.url === '/api/v1/cache/token' ? 'exchange' : 'other';
    const next = (script[route] ?? []).shift() ?? { status: 500, body: {} };
    if (next.destroy) return req.socket.destroy();
    res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
    res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  script = {};
  seen.length = 0;
});

const env = () => ({ ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret' });
const noSleep = async () => {};
const inHour = () => new Date(Date.now() + 3600_000).toISOString();
const granted = (token = 'cache-1', expiresAt = inHour()) => ({
  status: 200,
  body: { token, expiresAt, organizationId: 'org-1', repository: 'acme/web' },
});

describe('requestOidcToken', () => {
  it('asks the runner for the gitera-cache audience', async () => {
    script.oidc = [{ status: 200, body: { value: 'oidc-1' } }];
    assert.equal(await requestOidcToken({ env: env(), sleep: noSleep }), 'oidc-1');
    const url = new URL(seen[0].url, base);
    assert.equal(url.searchParams.get('audience'), 'gitera-cache');
    assert.equal(url.searchParams.get('api-version'), '2.0');
    assert.equal(seen[0].auth, 'bearer runner-secret');
  });

  it('explains a missing id-token permission', async () => {
    await assert.rejects(requestOidcToken({ env: {}, sleep: noSleep }), (error) => {
      assert.ok(error instanceof TokenError);
      assert.equal(error.code, 'no_id_token');
      assert.match(error.hint, /id-token: write/);
      return true;
    });
  });

  it('refuses an answer without a token', async () => {
    script.oidc = [{ status: 200, body: {} }];
    await assert.rejects(requestOidcToken({ env: env(), sleep: noSleep }), { code: 'oidc_request_failed' });
  });
});

describe('exchangeToken', () => {
  it('sends the OIDC token and returns the cache token', async () => {
    const expiresAt = inHour();
    script.exchange = [granted('cache-1', expiresAt)];
    const result = await exchangeToken(base, 'oidc-1', { sleep: noSleep });
    assert.deepEqual(result, { token: 'cache-1', expiresAt: Date.parse(expiresAt), organizationId: 'org-1', repository: 'acme/web' });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].auth, 'Bearer oidc-1');
  });

  it('passes the API code and a hint through, without retrying a refusal', async () => {
    script.exchange = [{ status: 403, body: { error: 'Install the app', code: 'not_installed' } }];
    await assert.rejects(exchangeToken(base, 'oidc-1', { sleep: noSleep }), (error) => {
      assert.equal(error.code, 'not_installed');
      assert.equal(error.status, 403);
      assert.equal(error.temporary, false);
      assert.match(error.hint, /GitHub App/);
      return true;
    });
    assert.equal(seen.length, 1);
  });

  it('retries 503 and 429, honouring Retry-After, then succeeds', async () => {
    const delays = [];
    script.exchange = [
      { status: 503, headers: { 'retry-after': '2' }, body: { code: 'github_unavailable' } },
      { status: 429, body: {} },
      granted(),
    ];
    const result = await exchangeToken(base, 'oidc-1', { sleep: async (ms) => delays.push(ms) });
    assert.equal(result.token, 'cache-1');
    assert.deepEqual(delays, [2000, 1000]);
  });

  it('gives up after the last attempt with the last code', async () => {
    script.exchange = Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 503, body: { code: 'oidc_unavailable' } }));
    await assert.rejects(exchangeToken(base, 'oidc-1', { sleep: noSleep }), (error) => {
      assert.equal(error.code, 'oidc_unavailable');
      assert.equal(error.temporary, true);
      return true;
    });
    assert.equal(seen.length, MAX_ATTEMPTS);
  });

  it('retries a dropped connection', async () => {
    script.exchange = [{ destroy: true }, granted()];
    assert.equal((await exchangeToken(base, 'oidc-1', { sleep: noSleep })).token, 'cache-1');
  });

  it('reports a network failure as temporary', async () => {
    await assert.rejects(exchangeToken('http://127.0.0.1:1', 'oidc-1', { sleep: noSleep }), (error) => {
      assert.equal(error.code, 'network');
      assert.equal(error.temporary, true);
      return true;
    });
  });

  it('refuses a 200 without a token or expiry', async () => {
    script.exchange = [{ status: 200, body: { token: 'x' } }];
    await assert.rejects(exchangeToken(base, 'oidc-1', { sleep: noSleep }), { code: 'bad_response' });
  });

  it('handles a non-JSON error page', async () => {
    script.exchange = [{ status: 404, body: '<html>nope</html>' }];
    await assert.rejects(exchangeToken(base, 'oidc-1', { sleep: noSleep }), { code: 'http_404' });
  });
});

describe('TokenSource', () => {
  it('reuses the token until it is close to expiry, then refreshes', async () => {
    let now = Date.now();
    const expiresAt = new Date(now + 3600_000).toISOString();
    script.oidc = [{ status: 200, body: { value: 'oidc-1' } }, { status: 200, body: { value: 'oidc-2' } }];
    script.exchange = [granted('cache-1', expiresAt), granted('cache-2')];
    const tokens = new TokenSource(base, { env: env(), sleep: noSleep, now: () => now });

    assert.equal(await tokens.get(), 'cache-1');
    now += 3600_000 - REFRESH_MARGIN_MS - 1000;
    assert.equal(await tokens.get(), 'cache-1');
    now += 2000;
    assert.equal(await tokens.get(), 'cache-2');
    assert.equal(seen.filter((r) => r.url === '/api/v1/cache/token').length, 2);
  });

  it('shares one refresh between concurrent callers', async () => {
    script.oidc = [{ status: 200, body: { value: 'oidc-1' } }];
    script.exchange = [granted('cache-1')];
    const tokens = new TokenSource(base, { env: env(), sleep: noSleep });
    const results = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    assert.deepEqual(results, ['cache-1', 'cache-1', 'cache-1']);
    assert.equal(seen.length, 2);
  });

  it('tries again on the next call after a failed refresh', async () => {
    script.oidc = [{ status: 200, body: { value: 'oidc-1' } }, { status: 200, body: { value: 'oidc-2' } }];
    script.exchange = [{ status: 403, body: { code: 'not_enabled' } }, granted('cache-2')];
    const tokens = new TokenSource(base, { env: env(), sleep: noSleep });
    await assert.rejects(tokens.get(), { code: 'not_enabled' });
    assert.equal(await tokens.get(), 'cache-2');
  });

  it('reports each new token, so the caller can mask it', async () => {
    const reported = [];
    script.oidc = [{ status: 200, body: { value: 'oidc-1' } }];
    script.exchange = [granted('cache-1')];
    const tokens = new TokenSource(base, { env: env(), sleep: noSleep, onToken: (t) => reported.push(t.token) });
    await tokens.get();
    assert.deepEqual(reported, ['cache-1']);
  });
});
