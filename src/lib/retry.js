'use strict';

/** Shared retry rules: network errors, 429 and 5xx are worth another try. */

const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 507 (storage full) and 501 are answers, not outages, so they are not retried. */
const TEMPORARY_STATUSES = new Set([429, 500, 502, 503, 504]);
const isTemporaryStatus = (status) => TEMPORARY_STATUSES.has(status);

function retryDelay(attempt, retryAfter) {
  const header = Number(retryAfter);
  const fromHeader = Number.isFinite(header) && header >= 0 ? header * 1000 : 0;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(fromHeader, 500 * 2 ** (attempt - 1)));
}

class NetworkError extends Error {}

/**
 * Calls `send` until it returns a response that is not temporary, or the
 * attempts run out. `send` returns `{ status, headers }` (a fetch Response or
 * the bucket transfer result). Throws NetworkError when every attempt failed
 * before a response.
 */
async function withRetry(what, send, { sleep = defaultSleep, attempts = MAX_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await send(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(retryDelay(attempt));
      continue;
    }
    if (!isTemporaryStatus(response.status) || attempt === attempts) return response;
    const retryAfter = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : response.headers?.['retry-after'];
    await sleep(retryDelay(attempt, retryAfter));
  }
  throw new NetworkError(`${what} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

module.exports = { withRetry, NetworkError, isTemporaryStatus, defaultSleep, MAX_ATTEMPTS };
