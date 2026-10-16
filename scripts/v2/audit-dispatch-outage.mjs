// Read-only audit of stored fixtures around the October 16 trigger outage.
// It does not fetch the provider, publish data, or claim provider freshness.
import fs from 'node:fs';
const target = JSON.parse(fs.readFileSync('config/public-worker-target.json', 'utf8'));
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!/^[a-f0-9]{32}$/i.test(account || '') || !token) throw new Error('Cloudflare audit credentials required');
const sql = `SELECT f.canonical_id AS fixture_id, f.kickoff_utc, f.date_jst,
  f.status_short, f.ingestion_state, f.published_revision, r.published_at
  FROM fixtures f LEFT JOIN fixture_revisions r ON r.id=f.published_revision
  WHERE f.date_jst BETWEEN '2026-10-15' AND '2026-10-16'
  AND f.kickoff_utc <= '2026-10-16T06:13:00.000Z' ORDER BY f.kickoff_utc`;
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${target.d1DatabaseId}/query`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sql }), redirect: 'error', signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Outage audit HTTP ${response.status}`);
const payload = await response.json();
if (payload.success !== true || payload.result?.length !== 1 || payload.result[0].success !== true || !Array.isArray(payload.result[0].results)) throw new Error('Invalid outage audit query result');
const rows = payload.result[0].results;
const candidates = rows.filter(row => row.kickoff_utc >= '2026-10-16T00:17:00.000Z');
const missingFinals = rows.filter(row => ['FT', 'AET', 'PEN'].includes(row.status_short) && row.published_revision === null);
const report = { passed: missingFinals.length === 0, outageStart: '2026-10-16T04:17:00.000Z', recoveryCompleted: '2026-10-16T06:13:00.000Z',
  scope: 'stored fixtures on October 15-16 before recovery; possible outage completions include kickoffs up to four hours earlier',
  providerFreshnessVerified: false, inspectedFixtures: rows.length, possibleOutageFixtures: candidates, unpublishedFinals: missingFinals,
  storedFixtures: rows };
fs.mkdirSync('.tmp/automation-review', { recursive: true });
fs.writeFileSync('.tmp/automation-review/outage.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
