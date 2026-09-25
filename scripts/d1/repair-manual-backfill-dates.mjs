#!/usr/bin/env node

import fs from 'node:fs';

export async function repairManualBackfillDates(dates, { url, token, fetchImpl = fetch }) {
  if (!Array.isArray(dates) || dates.length > 20 || !token) {
    throw new Error('Manual backfill recovery list or Admin token is invalid.');
  }
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('Protected Admin ingest HTTPS URL is required.');
  }
  endpoint.pathname = '/admin/v1/ingest';
  endpoint.search = '';
  endpoint.hash = '';
  for (const item of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.date)
      || !Array.isArray(item.fixtureIds) || item.fixtureIds.length === 0
      || item.fixtureIds.length > 20
      || new Set(item.fixtureIds).size !== item.fixtureIds.length
      || item.fixtureIds.some(id => !/^af:fixture:\d+$/.test(id))) {
      throw new Error('Manual backfill recovery date has invalid identities.');
    }
    const response = await fetchImpl(endpoint.toString(), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1',
        operation: 'date_index_refresh', date: item.date, fixtureIds: item.fixtureIds }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true
      || result.report?.operation !== 'date_index_refresh') {
      throw new Error(`Manual backfill date recovery failed for ${item.date} (${response.status}).`);
    }
  }
  return { repairedDates: dates.length };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  repairManualBackfillDates(JSON.parse(fs.readFileSync(file, 'utf8')), {
    url: process.env.ADMIN_INGEST_URL, token: process.env.ADMIN_INGEST_TOKEN,
  }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
