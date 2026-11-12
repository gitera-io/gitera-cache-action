'use strict';

/**
 * Gitera cache token client.
 *
 * 1. Ask the runner for a GitHub OIDC token with audience `gitera-cache`
 *    (needs `permissions: id-token: write`).
 * 2. Trade it at POST <api-url>/api/v1/cache/token for a one-hour Gitera
 *    cache token.
 * 3. Hand out the cached token, and trade a fresh OIDC token shortly before
 *    it expires, so jobs longer than an hour keep working.
 *
 * Temporary failures (network, 429, 5xx) are retried with back-off. Anything
 * else is a TokenError with the API's code and a hint for the job log.
 */

const { withRetry: sharedRetry, NetworkError, MAX_ATTEMPTS } = require('./retry');

const AUDIENCE = 'gitera-cache';
/** Refresh this long before expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const HINTS = {
  no_id_token: 'Add `permissions: id-token: write` to the job (or workflow).',
  invalid_oidc: 'The GitHub OIDC token was refused. Check that api-url points at Gitera.',
  missing_claims: 'The GitHub OIDC token has no repository ids. Use a github.com repository.',
  not_installed: 'Install the Gitera GitHub App on this repository, or grant it access to this repository.',
  repository_mismatch: 'The Gitera GitHub App installation belongs to another owner than this repository.',
  plan_required: 'Gitera Cache needs a paid Gitera plan.',
  not_enabled: 'Gitera Cache is not enabled for this account yet.',
  READ_ONLY_HOST: 'This Gitera host is read-only. Use https://app.gitera.io.',
};

class TokenError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }

  get hint() {
    return HINTS[this.code] ?? '';
  }

  /** Temporary: the caller may try again later in the job. */
  get temporary() {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Shared retry rules; a request that never got an answer is a temporary `network` error. */
async function withRetry(what, send, { sleep }) {
  try {
    return await sharedRetry(what, send, { sleep });
  } catch (error) {
    if (error instanceof NetworkError) throw new TokenError(error.message, 'network');
    throw error;
  }
}

/** Reads a GitHub OIDC token for the Gitera audience from the runner. */
async function requestOidcToken({ env = process.env, fetch = globalThis.fetch, sleep = defaultSleep } = {}) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new TokenError('The job cannot request a GitHub OIDC token', 'no_id_token', 403);
  }
  const target = new URL(url);
  target.searchParams.set('audience', AUDIENCE);
  const response = await withRetry(
    'GitHub OIDC token request',
    () =>
      fetch(target, {
        headers: { Authorization: `bearer ${requestToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    { sleep }
  );
  const body = await readJson(response);
  if (!response.ok || typeof body?.value !== 'string' || !body.value) {
    throw new TokenError(`GitHub OIDC token request answered ${response.status}`, 'oidc_request_failed', response.status);
  }
  return body.value;
}

/**
 * Trades a GitHub OIDC token for a Gitera cache token. With `lookup`
 * (`{ tool, name, prefixes }`), the folder lookup runs in the same call and
 * its `{ hit }` comes back as `result.lookup`. It is left out when the server
 * did not run it (an older server, or a failed lookup).
 */
async function exchangeToken(apiUrl, oidcToken, { fetch = globalThis.fetch, sleep = defaultSleep, lookup } = {}) {
  const body = lookup ? JSON.stringify({ lookup }) : undefined;
  const headers = { Authorization: `Bearer ${oidcToken}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await withRetry(
    'Gitera token exchange',
    () =>
      fetch(`${apiUrl}/api/v1/cache/token`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    { sleep }
  );
  const json = await readJson(response);
  if (!response.ok) {
    const code = typeof json?.code === 'string' ? json.code : `http_${response.status}`;
    const message = typeof json?.error === 'string' ? json.error : `Gitera answered ${response.status}`;
    throw new TokenError(message, code, response.status);
  }
  const expiresAt = Date.parse(json?.expiresAt);
  if (typeof json?.token !== 'string' || !json.token || !Number.isFinite(expiresAt)) {
    throw new TokenError('Gitera answered without a cache token', 'bad_response', response.status);
  }
  const result = {
    token: json.token,
    expiresAt,
    organizationId: typeof json.organizationId === 'string' ? json.organizationId : null,
    repository: typeof json.repository === 'string' ? json.repository : null,
  };
  const hit = json.lookup?.hit;
  if (lookup && (hit === null || (hit && typeof hit === 'object' && typeof hit.url === 'string'))) result.lookup = { hit };
  return result;
}

/**
 * Hands out a valid cache token, refreshing it shortly before it expires.
 * Concurrent callers share one refresh.
 */
class TokenSource {
  constructor(apiUrl, options = {}) {
    this.apiUrl = apiUrl;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.onToken = options.onToken ?? (() => {});
    this.current = options.initial && Number.isFinite(options.initial.expiresAt) ? options.initial : null;
    this.pending = null;
  }

  async get() {
    if (this.current && this.current.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.current.token;
    return (await this.refresh()).token;
  }

  /**
   * Forces a new token, for example after the API answered 401. `lookup`
   * (first login only) asks for a folder lookup in the same call; see
   * exchangeToken. A caller joining a refresh already running gets its result.
   */
  refresh({ lookup } = {}) {
    if (!this.pending) {
      this.pending = (async () => {
        const oidc = await requestOidcToken(this.options);
        const result = await exchangeToken(this.apiUrl, oidc, { ...this.options, lookup });
        this.current = result;
        this.onToken(result);
        return result;
      })().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }
}

module.exports = { TokenSource, TokenError, requestOidcToken, exchangeToken, AUDIENCE, REFRESH_MARGIN_MS, MAX_ATTEMPTS };
