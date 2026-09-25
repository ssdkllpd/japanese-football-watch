#!/usr/bin/env node

export async function checkFixtureCorrections({ url, token, fixtureId, competitionId, seasonId, date,
  fetchImpl = fetch }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('Admin ingest URL must use HTTPS without embedded credentials.');
  }
  endpoint.pathname = '/admin/v1/ingest';
  endpoint.search = '';
  endpoint.hash = '';
  if (!token) throw new Error('Admin ingest token is required.');
  const response = await fetchImpl(endpoint.toString(), {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_correction_guard',
      fixtureId, competitionId, seasonId, date,
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error(`Automation fixture correction guard rejected ${fixtureId}: ${result?.detail || response.status}.`);
  }
  return result.report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fixtureId, competitionId, seasonId, date] = process.argv.slice(2);
  checkFixtureCorrections({
    url: process.env.ADMIN_INGEST_URL,
    token: process.env.ADMIN_INGEST_TOKEN,
    fixtureId, competitionId, seasonId, date,
  }).then(report => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
