import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeAdminIngestPlan, validatePlan } from './request-admin-ingest.mjs';

// Each fixture owns its publication and both date refreshes. A failed fixture
// remains retryable without marking unrelated fixtures as completed.
export async function executeAutomationAdminPlan(plan, options) {
  validatePlan(plan, options.planDirectory);
  const ready = options.readyFixtures ? new Set(options.readyFixtures) : null;
  const outcomes = [];
  const successfulFixtures = [];
  const successfulStandings = [];
  const empty = { schemaVersion: plan.schemaVersion, fixtures: [], standings: [],
    dateIndexRefreshes: [], dateIndexCoverages: [], expectedTotals: null };
  for (const fixture of plan.fixtures) {
    if (ready && !ready.has(fixture.fixtureId)) {
      outcomes.push({ identity: fixture.fixtureId, passed: false, reason: 'artifact_quarantined' });
      continue;
    }
    const refreshes = (plan.dateIndexRefreshes || []).flatMap(scope => {
      const fixtureIds = scope.fixtureIds.filter(id => id === fixture.fixtureId);
      const departures = (scope.departedFixtures || []).filter(item => item.fixtureId === fixture.fixtureId);
      return fixtureIds.length || departures.length
        ? [{ date: scope.date, fixtureIds, ...(departures.length ? { departedFixtures: departures } : {}) }] : [];
    });
    const report = await executeAdminIngestPlan({ ...empty, fixtures: [fixture],
      dateIndexRefreshes: refreshes }, options);
    outcomes.push({ identity: fixture.fixtureId, passed: report.passed, report });
    if (report.passed) successfulFixtures.push(fixture.fixtureId);
  }
  for (const scope of plan.standings) {
    const report = await executeAdminIngestPlan({ ...empty, standings: [scope] }, options);
    const identity = `${scope.competitionId}/${scope.seasonId}`;
    outcomes.push({ identity, passed: report.passed, report });
    if (report.passed) successfulStandings.push(identity);
  }
  return { schemaVersion: 'jfw-automation-publication-report/1', outcomes,
    successfulFixtures, successfulStandings, passed: outcomes.every(item => item.passed) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => {
    if (item.startsWith('--')) pairs.push([item.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const readyFixtures = fs.readFileSync(args.ready, 'utf8').trim().split(/\s+/)
    .filter(Boolean).map(id => `af:fixture:${id}`);
  const report = await executeAutomationAdminPlan(plan, { url: args.url,
    token: process.env.ADMIN_INGEST_TOKEN, planDirectory: path.dirname(path.resolve(args.plan)), readyFixtures });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, fixtures: report.successfulFixtures.length,
    standings: report.successfulStandings.length }));
  // The workflow persists the verified subset before failing visibly on partial success.
}
