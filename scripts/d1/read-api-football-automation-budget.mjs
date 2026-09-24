#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function readAutomationPublishBudget({ url, token, fetchImpl = fetch }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !token) {
    throw new Error('Protected Admin ingest HTTPS URL and token are required.');
  }
  endpoint.pathname = '/admin/v1/ingest';
  endpoint.search = '';
  endpoint.hash = '';
  const response = await fetchImpl(endpoint.toString(), {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_publish_budget',
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true
    || result.report?.operation !== 'fixture_publish_budget') {
    throw new Error(`D1 fixture publication budget is unavailable (${response.status}).`);
  }
  return result.report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outIndex = process.argv.indexOf('--out');
  const output = process.argv[outIndex + 1];
  if (outIndex < 0 || !output) throw new Error('Use --out FILE.');
  readAutomationPublishBudget({
    url: process.env.ADMIN_INGEST_URL, token: process.env.ADMIN_INGEST_TOKEN,
  }).then(report => {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  }).catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
