'use strict';

const fs = require('node:fs');
const { PLAN_VERSION } = require('./api-football-automation-plan');

function checkManualBackfillBudget(before, current, plan) {
  if (plan?.schemaVersion !== PLAN_VERSION || !Array.isArray(plan.detailFetches)
    || !before || !current || before.operation !== 'fixture_publish_budget'
    || current.operation !== 'fixture_publish_budget'
    || before.dateUtc !== current.dateUtc
    || before.dateUtc !== plan.generatedAt?.slice(0, 10)
    || !Array.isArray(before.fixtureIds) || !Array.isArray(current.fixtureIds)
    || before.fixtureIds.length > 20 || current.fixtureIds.length > 20
    || JSON.stringify([...before.fixtureIds].sort()) !== JSON.stringify([...current.fixtureIds].sort())
    || new Set(plan.detailFetches.map(item => item.fixtureId)).size !== plan.detailFetches.length
    || plan.detailFetches.some(item => current.fixtureIds.includes(item.fixtureId))
    || current.fixtureIds.length + plan.detailFetches.length > 20) {
    throw new Error('D1 publication budget changed or the planned batch exceeds the daily cap.');
  }
}

if (require.main === module) {
  try {
    const [before, current, plan] = process.argv.slice(2).map(file =>
      JSON.parse(fs.readFileSync(file, 'utf8')));
    checkManualBackfillBudget(before, current, plan);
  } catch (error) { console.error(error?.message || error); process.exitCode = 1; }
}

module.exports = { checkManualBackfillBudget };
