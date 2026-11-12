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

const AUDIENCE = 'gitera-cache';
/** Refresh this long before expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30 * 1000;
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

function retryDelay(attempt, response) {
  const header = Number(response?.headers?.get?.('retry-after'));
  const fromHeader = Number.isFinite(header) && header >= 0 ? header * 1000 : 0;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(fromHeader, 500 * 2 ** (attempt - 1)));
}

const isTemporaryStatus = (status) => status === 429 || status >= 500;

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Sends one request, retrying network errors and temporary statuses.
 * Returns the final Response; throws TokenError when every attempt failed on the network.
 */
async function withRetry(what, send, { sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await send();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(retryDelay(attempt));
      continue;
    }
    if (!isTemporaryStatus(response.status) || attempt === MAX_ATTEMPTS) return response;
    await sleep(retryDelay(attempt, response));
  }
  throw new TokenError(`${what} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, 'network');
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

/** Trades a GitHub OIDC token for a Gitera cache token. */
async function exchangeToken(apiUrl, oidcToken, { fetch = globalThis.fetch, sleep = defaultSleep } = {}) {
  const response = await withRetry(
    'Gitera token exchange',
    () =>
      fetch(`${apiUrl}/api/v1/cache/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${oidcToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    { sleep }
  );
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body?.code === 'string' ? body.code : `http_${response.status}`;
    const message = typeof body?.error === 'string' ? body.error : `Gitera answered ${response.status}`;
    throw new TokenError(message, code, response.status);
  }
  const expiresAt = Date.parse(body?.expiresAt);
  if (typeof body?.token !== 'string' || !body.token || !Number.isFinite(expiresAt)) {
    throw new TokenError('Gitera answered without a cache token', 'bad_response', response.status);
  }
  return {
    token: body.token,
    expiresAt,
    organizationId: typeof body.organizationId === 'string' ? body.organizationId : null,
    repository: typeof body.repository === 'string' ? body.repository : null,
  };
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
    this.current = null;
    this.pending = null;
  }

  async get() {
    if (this.current && this.current.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.current.token;
    return (await this.refresh()).token;
  }

  /** Forces a new token, for example after the API answered 401. */
  refresh() {
    if (!this.pending) {
      this.pending = (async () => {
        const oidc = await requestOidcToken(this.options);
        const result = await exchangeToken(this.apiUrl, oidc, this.options);
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
