'use strict';

const GLOBAL_DAILY_CAP = 240;
const AUTOMATION_DAILY_CAP = 40;

// Receipts must partition the global ledger. Historical receipts have no
// reliable source and remain conservatively charged to manual catch-up.
function validatePublicationBudget(budget, dateUtc) {
  const validIds = ids => Array.isArray(ids)
    && ids.every(id => /^af:fixture:\d+$/.test(id))
    && new Set(ids).size === ids.length;
  if (!budget || budget.dateUtc !== dateUtc
    || !validIds(budget.fixtureIds) || !validIds(budget.automationFixtureIds)
    || !validIds(budget.manualFixtureIds)
    || budget.fixtureIds.length > GLOBAL_DAILY_CAP
    || budget.remaining !== GLOBAL_DAILY_CAP - budget.fixtureIds.length) {
    throw new Error('D1 daily publication budget is missing or stale, or source receipts are invalid.');
  }
  const combined = [...budget.automationFixtureIds, ...budget.manualFixtureIds];
  if (new Set(combined).size !== combined.length
    || JSON.stringify(combined.sort()) !== JSON.stringify([...budget.fixtureIds].sort())) {
    throw new Error('D1 publication source receipts do not partition the global ledger.');
  }
  return budget;
}

module.exports = { GLOBAL_DAILY_CAP, AUTOMATION_DAILY_CAP, validatePublicationBudget };
