'use strict';
const fs = require('node:fs');
function summarizeSchedulePlan(plan) {
  if (plan?.schemaVersion !== 'jfw-fixture-schedule-plan/1' || !Array.isArray(plan.held)) {
    throw new Error('Schedule summary plan is invalid.');
  }
  const clean = value => String(value ?? '').replace(/[\r\n|]/g, ' ');
  const lines = [`Schedule changes: ${plan.changes.length}; next batch: ${Math.min(20, plan.changes.length)}; held: ${plan.held.length}.`];
  if (plan.held.length) {
    lines.push('', '| Fixture | Reason | Stored kickoff / status | Provider kickoff / status |',
      '|---|---|---|---|');
    for (const item of plan.held) lines.push(`| ${clean(item.fixtureId)} | ${clean(item.reason)} | ${clean(item.storedKickoffUtc)} ${clean(item.storedStatus)} | ${clean(item.providerKickoffUtc)} ${clean(item.providerStatus)} |`);
  }
  return `${lines.join('\n')}\n`;
}
if (require.main === module) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (plan.held?.length) console.error(`::warning::${plan.held.length} fixtures require reconciliation; inspect the run summary.`);
  console.log(summarizeSchedulePlan(plan));
}
module.exports = { summarizeSchedulePlan };
