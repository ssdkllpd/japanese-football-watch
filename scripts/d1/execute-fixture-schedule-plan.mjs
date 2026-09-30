import fs from 'node:fs';

const endpoint = new URL(process.env.ADMIN_INGEST_URL);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
  || !process.env.ADMIN_INGEST_TOKEN) throw new Error('Protected Admin endpoint is required.');
endpoint.pathname = '/admin/v1/ingest';
endpoint.search = '';

async function send(request) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${process.env.ADMIN_INGEST_TOKEN}`,
      'content-type': 'application/json' }, body: JSON.stringify(request) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Schedule ${request.operation} failed (${response.status}): ${body?.detail || 'unknown'}`);
  }
  return body.report;
}

const repair = { schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_schedule_repair' };
const [mode, planFile] = process.argv.slice(2);
if (mode === 'repair') {
  // Drain previous partial publications before planning from the current D1 inventory.
  for (let count = 0; count < 20; count += 1) {
    const result = await send(repair);
    if (!result.repaired) process.exit(0);
  }
  throw new Error('Schedule repair backlog exceeded 20 fixtures.');
}
if (mode !== 'execute' || !planFile) throw new Error('Use repair or execute PLAN.json.');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
if (plan.schemaVersion !== 'jfw-fixture-schedule-plan/1'
  || !Array.isArray(plan.changes) || plan.changes.length > 20) throw new Error('Invalid schedule plan.');
for (const request of plan.changes) {
  await send(request);
  const outcome = await send(repair);
  if (outcome.repaired !== request.fixtureId) throw new Error('Schedule repair identity mismatch.');
}
console.log(JSON.stringify({ updated: plan.changes.length, held: plan.held.length }));
