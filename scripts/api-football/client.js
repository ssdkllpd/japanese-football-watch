'use strict';

const DEFAULT_BASE_URL = 'https://v3.football.api-sports.io';

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractQuota(headers) {
  return {
    dailyLimit: toInt(headers.get('x-ratelimit-requests-limit')),
    dailyRemaining: toInt(headers.get('x-ratelimit-requests-remaining')),
    minuteLimit: toInt(headers.get('x-ratelimit-limit')),
    minuteRemaining: toInt(headers.get('x-ratelimit-remaining')),
  };
}

function hasApiErrors(errors) {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === 'object') return Object.keys(errors).length > 0;
  return true;
}

class ApiFootballError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiFootballError';
    this.status = details.status ?? null;
    this.quota = details.quota ?? null;
    this.apiErrors = details.apiErrors ?? null;
  }
}

class ApiFootballClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    minimumIntervalMs = 0,
    dailyReserve = 0,
    initialDailyRemaining = null,
    sleepImpl = delay => new Promise(resolve => setTimeout(resolve, delay)),
    nowImpl = Date.now,
  } = {}) {
    if (!apiKey || !String(apiKey).trim()) {
      throw new ApiFootballError('API_FOOTBALL_KEY is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new ApiFootballError('A Fetch API implementation is required.');
    }
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new ApiFootballError('minimumIntervalMs must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(dailyReserve) || dailyReserve < 0) {
      throw new ApiFootballError('dailyReserve must be a non-negative safe integer.');
    }
    if (initialDailyRemaining !== null
      && (!Number.isSafeInteger(initialDailyRemaining) || initialDailyRemaining < 0)) {
      throw new ApiFootballError('initialDailyRemaining must be null or a non-negative safe integer.');
    }
    if (typeof sleepImpl !== 'function' || typeof nowImpl !== 'function') {
      throw new ApiFootballError('sleepImpl and nowImpl must be functions.');
    }

    this.apiKey = String(apiKey).trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.minimumIntervalMs = minimumIntervalMs;
    this.dailyReserve = dailyReserve;
    this.sleepImpl = sleepImpl;
    this.nowImpl = nowImpl;
    this.lastRequestStartedAt = null;
    this.lastQuota = initialDailyRemaining === null ? null : { dailyRemaining: initialDailyRemaining };
    this.requestQueue = Promise.resolve();
  }

  buildUrl(path, params = {}) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    if (!cleanPath) throw new ApiFootballError('API-Football endpoint path is required.');

    const url = new URL(`${this.baseUrl}/${cleanPath}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async performGet(path, params = {}) {
    const isStatus = cleanEndpoint(path) === 'status';
    if (!isStatus && this.lastQuota?.dailyRemaining !== null
      && this.lastQuota?.dailyRemaining !== undefined
      && this.lastQuota.dailyRemaining <= this.dailyReserve) {
      throw new ApiFootballError(
        `API-Football daily reserve reached (${this.lastQuota.dailyRemaining} remaining; reserve ${this.dailyReserve}).`,
        { quota: this.lastQuota },
      );
    }
    if (this.lastRequestStartedAt !== null) {
      const waitMs = this.minimumIntervalMs - (this.nowImpl() - this.lastRequestStartedAt);
      if (waitMs > 0) await this.sleepImpl(waitMs);
    }
    this.lastRequestStartedAt = this.nowImpl();
    const url = this.buildUrl(path, params);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-apisports-key': this.apiKey,
      },
    });

    const quota = extractQuota(response.headers);
    this.lastQuota = quota;
    if (!isStatus && this.dailyReserve > 0 && quota.dailyRemaining === null) {
      throw new ApiFootballError('API-Football omitted the daily remaining quota required by the reserve policy.', {
        status: response.status,
        quota,
      });
    }
    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      throw new ApiFootballError(`API-Football returned non-JSON data (${response.status}).`, {
        status: response.status,
        quota,
      });
    }

    if (!response.ok) {
      throw new ApiFootballError(`API-Football HTTP ${response.status}.`, {
        status: response.status,
        quota,
        apiErrors: payload?.errors ?? null,
      });
    }

    if (hasApiErrors(payload?.errors)) {
      throw new ApiFootballError('API-Football returned an API-level error.', {
        status: response.status,
        quota,
        apiErrors: payload.errors,
      });
    }

    return {
      data: payload,
      quota,
      request: {
        endpoint: cleanEndpoint(path),
        parameters: { ...params },
      },
    };
  }

  get(path, params = {}) {
    const request = this.requestQueue.then(
      () => this.performGet(path, params),
      () => this.performGet(path, params),
    );
    this.requestQueue = request.catch(() => undefined);
    return request;
  }

  async refreshDailyQuota() {
    // API-Sports documents /status as exempt from the daily request quota.
    const status = await this.get('status');
    const requests = status.data?.response?.requests;
    const used = Number(requests?.current);
    const limit = Number(requests?.limit_day);
    if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit)
      || limit < used) {
      throw new ApiFootballError('API-Football status omitted a valid daily request balance.');
    }
    const remaining = limit - used;
    this.lastQuota = {
      ...status.quota,
      dailyLimit: limit,
      dailyRemaining: status.quota.dailyRemaining === null
        ? remaining : Math.min(status.quota.dailyRemaining, remaining),
    };
    return this.lastQuota;
  }
}

function cleanEndpoint(path) {
  return String(path || '').replace(/^\/+/, '');
}

function createClientFromEnv(env = process.env, options = {}) {
  const minimumIntervalMs = env.API_FOOTBALL_MIN_INTERVAL_MS === undefined
    ? 0 : toInt(env.API_FOOTBALL_MIN_INTERVAL_MS);
  const dailyReserve = env.API_FOOTBALL_DAILY_RESERVE === undefined
    ? 0 : toInt(env.API_FOOTBALL_DAILY_RESERVE);
  const initialDailyRemaining = env.API_FOOTBALL_INITIAL_DAILY_REMAINING === undefined
    || env.API_FOOTBALL_INITIAL_DAILY_REMAINING === ''
    ? null : toInt(env.API_FOOTBALL_INITIAL_DAILY_REMAINING);
  return new ApiFootballClient({
    apiKey: env.API_FOOTBALL_KEY,
    baseUrl: env.API_FOOTBALL_BASE_URL || DEFAULT_BASE_URL,
    minimumIntervalMs,
    dailyReserve,
    initialDailyRemaining,
    ...options,
  });
}

module.exports = {
  ApiFootballClient,
  ApiFootballError,
  DEFAULT_BASE_URL,
  createClientFromEnv,
  extractQuota,
  hasApiErrors,
};
