import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ROWS_PER_MONTH = 50_000_000;
const STOP_AT_ROWS = 40_000_000; // Reserve 10 million rows for reporting lag and other account activity.
const QUERY = `query D1PaidBackfillRows($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) {
        dimensions { date databaseId }
        sum { rowsWritten }
      }
    }
  }
}`;

export function summarizePaidUsage(payload, start, end) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error('Cloudflare D1 analytics returned errors.');
  }
  const accounts = payload?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error('Cloudflare D1 account analytics is missing or ambiguous.');
  }
  const groups = accounts[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(groups) || groups.length >= 10000) {
    throw new Error('Cloudflare D1 analytics is missing or truncated.');
  }
  let rows = 0;
  const unique = new Set();
  for (const group of groups) {
    const date = group?.dimensions?.date;
    const databaseId = group?.dimensions?.databaseId;
    const written = group?.sum?.rowsWritten;
    const key = `${date}/${databaseId}`;
    if (typeof date !== 'string' || date < start || date > end
      || typeof databaseId !== 'string' || !databaseId
      || !Number.isSafeInteger(written) || written < 0 || unique.has(key)) {
      throw new Error('Cloudflare D1 account analytics group is invalid or duplicated.');
    }
    unique.add(key);
    rows += written;
    if (!Number.isSafeInteger(rows)) throw new Error('D1 usage total is unsafe.');
  }
  if (rows > STOP_AT_ROWS) {
    throw new Error('Paid bulk catch-up stopped at the conservative D1 monthly usage ceiling.');
  }
  return { rowsWrittenTrailing31Days: rows, stopAtRows: STOP_AT_ROWS,
    includedMonthlyRows: MAX_ROWS_PER_MONTH, databaseDays: unique.size };
}

export async function checkPaidBackfillCapacity(env, fetchImpl = fetch, now = new Date()) {
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')
    || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Cloudflare account analytics credentials are required.');
  }
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const response = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: {
      accountTag: env.CLOUDFLARE_ACCOUNT_ID, start, end,
    } }),
  });
  if (!response.ok) throw new Error(`Cloudflare D1 analytics returned HTTP ${response.status}.`);
  return { schemaVersion: 'jfw-paid-backfill-usage/1', startDateUtc: start, endDateUtc: end,
    ...summarizePaidUsage(await response.json(), start, end), observedAt: now.toISOString() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--out' || !process.argv[3]) {
      throw new Error('Use --out FILE.');
    }
    const report = await checkPaidBackfillCapacity(process.env);
    fs.mkdirSync(path.dirname(path.resolve(process.argv[3])), { recursive: true });
    fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'D1 paid capacity check failed.');
    process.exitCode = 1;
  }
}
