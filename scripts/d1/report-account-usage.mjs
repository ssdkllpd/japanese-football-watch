import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUERY = `query D1RowsWritten($accountTag: string!, $date: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        dimensions { date databaseId }
        sum { rowsWritten }
      }
    }
  }
}`;

export function summarizeUsage(payload, date, databaseId) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error('Cloudflare GraphQL returned an error; check token Analytics permissions and query support.');
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error('Expected exactly one Cloudflare analytics account.');
  }
  const groups = accounts[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(groups) || groups.length >= 10000) {
    throw new Error('D1 analytics result is missing or may have reached the result limit.');
  }
  const databases = new Map();
  for (const group of groups) {
    const id = group?.dimensions?.databaseId;
    const count = group?.sum?.rowsWritten;
    if (group?.dimensions?.date !== date || typeof id !== 'string' || !id ||
        !Number.isSafeInteger(count) || count < 0 || databases.has(id)) {
      throw new Error('Invalid or duplicated D1 analytics group.');
    }
    databases.set(id, count);
  }
  const total = [...databases.values()].reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw new Error('D1 row count exceeded safe integer range.');
  return {
    schemaVersion: 'jfw-d1-account-usage/1', dateUtc: date,
    rowsWrittenAllDatabases: total,
    rowsWrittenStagingDatabase: databaseId ? (databases.get(databaseId) ?? 0) : null,
    databaseCount: databases.size,
    note: 'Cloudflare analytics can lag recent writes; this is an observation, not a guaranteed live quota balance.',
  };
}

export async function reportUsage(env, fetchImpl = fetch, now = new Date()) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const databaseId = env.D1_DATABASE_ID;
  if (!/^[a-f\d]{32}$/i.test(account || '') || !token ||
      !/^[a-f\d-]{36}$/i.test(databaseId || '')) {
    throw new Error('Cloudflare account, API token and D1 database ID are required.');
  }
  const date = now.toISOString().slice(0, 10);
  const response = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { accountTag: account, date } }),
  });
  if (!response.ok) throw new Error(`Cloudflare GraphQL returned HTTP ${response.status}.`);
  const result = summarizeUsage(await response.json(), date, databaseId);
  return { ...result, observedAt: now.toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await reportUsage(process.env);
    const output = '.tmp/d1-account-usage/report.json';
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Never print a raw GraphQL response: it may include account metadata.
    console.error(error instanceof Error ? error.message : 'D1 usage query failed.');
    process.exitCode = 1;
  }
}
