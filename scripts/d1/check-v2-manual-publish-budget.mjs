#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAutomationPublishBudget } from './read-api-football-automation-budget.mjs';

export function assertManualPublishBudget(plan, budget, now = new Date()) {
  const fixtureIds = plan?.fixtures?.map(fixture => fixture.fixtureId);
  if (plan?.schemaVersion !== 'jfw-d1-admin-ingest-plan/1' || !Array.isArray(fixtureIds)
    || new Set(fixtureIds).size !== fixtureIds.length
    || fixtureIds.some(id => !/^af:fixture:\d+$/.test(id))) {
    throw new Error('Manual fixture publication plan is invalid.');
  }
  if (budget?.schemaVersion !== 'jfw-d1-admin-ingest-report/1'
    || budget.operation !== 'fixture_publish_budget'
    || budget.dateUtc !== now.toISOString().slice(0, 10)
    || !Array.isArray(budget.fixtureIds)
    || !Number.isSafeInteger(budget.remaining) || budget.remaining < 0) {
    throw new Error('D1 fixture publication budget is stale or invalid.');
  }
  if (fixtureIds.some(id => budget.fixtureIds.includes(id))) {
    throw new Error('A fixture was already published today; manual publication is blocked before R2 writes.');
  }
  if (fixtureIds.length > budget.remaining) {
    throw new Error('D1 fixture daily publication cap would be exceeded; manual publication is blocked before R2 writes.');
  }
  return { fixtureCount: fixtureIds.length, remaining: budget.remaining - fixtureIds.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--plan');
  const planPath = process.argv[index + 1];
  if (index < 0 || !planPath) throw new Error('Use --plan FILE.');
  readAutomationPublishBudget({
    url: process.env.ADMIN_INGEST_URL, token: process.env.ADMIN_INGEST_TOKEN,
  }).then(budget => {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    console.log(JSON.stringify(assertManualPublishBudget(plan, budget)));
  }).catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
