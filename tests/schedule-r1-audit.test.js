import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, baseline, update, dateIndexR2Key, competitionDateIndexR2Key } from './helpers/schedule-harness.mjs';
import { auditScheduleSync, affectedScheduleScopes } from '../scripts/d1/audit-fixture-schedule-sync.mjs';
import { SCHEDULE_INVENTORY_SQL } from '../scripts/d1/capture-schedule-audit.mjs';

async function evidence() {
  const ctx = setup([
    { id: 5101, league: 39, kickoff: '2026-10-01T10:00:00.000Z' },
    { id: 5102, league: 39, kickoff: '2026-10-02T12:00:00.000Z' },
    { id: 5103, league: 48, kickoff: '2026-10-02T11:00:00.000Z' },
  ]);
  await baseline(ctx, ['2026-10-01', '2026-10-02']);
  const before = ctx.db.prepare(SCHEDULE_INVENTORY_SQL).all();
  const change = update(5101, 39, '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z');
  assert.equal((await ctx.send(change)).status, 200);
  assert.equal((await ctx.send({ operation: 'fixture_schedule_repair' })).status, 200);
  const after = ctx.db.prepare(SCHEDULE_INVENTORY_SQL).all();
  const scopes = affectedScheduleScopes([change], before, after);
  const r2 = {};
  for (const [key, scope] of scopes) r2[key] = JSON.parse(ctx.objects.get(scope.competitionId
    ? competitionDateIndexR2Key(scope.competitionId, scope.date) : dateIndexR2Key(scope.date)));
  return { ctx, data: { changes: [change], before, after, inventoryEnd: structuredClone(after),
    pending: [], r2, genericCoverages: ctx.db.prepare('SELECT * FROM date_index_coverages').all(),
    competitionCoverages: ctx.db.prepare('SELECT c.canonical_id AS competition_id,coverage.date_jst,coverage.fixture_count,coverage.fixture_id_digest FROM competition_date_index_coverages coverage JOIN competitions c ON c.id=coverage.competition_id').all(),
    publicSamples: [{ scope: 'all/2026-10-02', status: 200, payload: structuredClone(r2['all/2026-10-02']) }] } };
}
test('schedule audit accepts all-competition coverage including a fixture outside the ten seasons', async () => {
  const { ctx, data } = await evidence();
  const report = auditScheduleSync(data);
  assert.equal(report.verifiedChanges, 1);
  assert.equal(report.verifiedPreservedFixtures, 2);
  assert.equal(report.providerFreshnessVerified, false);
  assert.equal(report.browserUiVerified, false);
  ctx.db.close();
});
test('schedule audit rejects stale R2 kickoff and status even when the ID digest matches', async () => {
  const { ctx, data } = await evidence();
  data.r2['all/2026-10-02'].fixtures[0].kickoffUtc = '2026-10-02T09:00:00.000Z';
  data.r2['all/2026-10-02'].fixtures[0].status.short = 'PST';
  assert.throws(() => auditScheduleSync(data), /R2.*differs/);
  ctx.db.close();
});
test('schedule audit rejects mutation of an unselected or held fixture', async () => {
  const { ctx, data } = await evidence();
  for (const rows of [data.after, data.inventoryEnd]) rows.find(row => row.fixture_id === 'af:fixture:5102').status_short = 'CANC';
  assert.throws(() => auditScheduleSync(data), /Unselected or held/);
  ctx.db.close();
});
test('schedule audit requires R2 and public evidence and a stable ending inventory', async () => {
  const { ctx, data } = await evidence();
  assert.throws(() => auditScheduleSync({ ...data, r2: {} }), /R2 evidence/);
  assert.throws(() => auditScheduleSync({ ...data, publicSamples: [] }), /Public Worker/);
  data.inventoryEnd[0].status_short = 'CANC';
  assert.throws(() => auditScheduleSync(data), /changed during audit/);
  ctx.db.close();
});
