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
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey || !String(apiKey).trim()) {
      throw new ApiFootballError('API_FOOTBALL_KEY is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new ApiFootballError('A Fetch API implementation is required.');
    }

    this.apiKey = String(apiKey).trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
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

  async get(path, params = {}) {
    const url = this.buildUrl(path, params);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-apisports-key': this.apiKey,
      },
    });

    const quota = extractQuota(response.headers);
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
}

function cleanEndpoint(path) {
  return String(path || '').replace(/^\/+/, '');
}

function createClientFromEnv(env = process.env, options = {}) {
  return new ApiFootballClient({
    apiKey: env.API_FOOTBALL_KEY,
    baseUrl: env.API_FOOTBALL_BASE_URL || DEFAULT_BASE_URL,
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
