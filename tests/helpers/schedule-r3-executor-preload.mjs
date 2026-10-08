// Preload for the REAL scripts/d1/execute-fixture-schedule-plan.mjs run as a subprocess.
// fetch -> in-process real Admin Worker handler on node:sqlite (migrations 0001-0011); Cloudflare analytics is canned.
import fs from 'node:fs';
import { setup, baseline, jst, pendingRows, queueRows, r2Ids, fixtureRow, dateIndexR2Key, competitionDateIndexR2Key, handleAdminIngest } from './schedule-r3-harness.mjs';
const scenario = JSON.parse(fs.readFileSync(process.env.R3_SCENARIO, 'utf8'));
const ctx = setup(scenario.fixtures);
await baseline(ctx, scenario.baselineDates);
for (const sql of scenario.preSql || []) ctx.db.exec(sql);
for (const [key, value] of Object.entries(scenario.r2Overrides || {})) ctx.objects.set(key, value);
if (scenario.orphan) { const key = dateIndexR2Key(scenario.orphan.date); const payload = JSON.parse(ctx.objects.get(key));
  payload.fixtures.push({ ...structuredClone(payload.fixtures.at(-1)), fixtureId: `af:fixture:${scenario.orphan.id}` }); ctx.objects.set(key, JSON.stringify(payload)); }
for (const payload of scenario.preAdmin || []) { const r = await ctx.send(payload); if (r.status !== 200) throw new Error(`preAdmin failed: ${JSON.stringify(r.body)}`); }
const calls = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.cloudflare.com')) {
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }), { status: 200 });
  }
  const body = JSON.parse(init.body);
  const response = await handleAdminIngest(new Request(url, init), ctx.env);
  const copy = await response.clone().json().catch(() => null);
  calls.push({ op: body.operation, fixture: body.fixtureId || null, status: response.status,
    result: response.ok ? (copy?.report?.repaired !== undefined ? { repaired: copy.report.repaired, partial: copy.report.partial || false } : 'ok') : copy?.detail });
  return response;
};
process.on('exit', code => {
  const dates = scenario.reportDates;
  fs.writeFileSync(process.env.R3_OUT, JSON.stringify({ exitCode: code, calls,
    pending: pendingRows(ctx), queue: queueRows(ctx),
    fixtures: Object.fromEntries(scenario.fixtures.map(f => [f.id, fixtureRow(ctx, f.id)])),
    r2Generic: Object.fromEntries(dates.map(d => [d, r2Ids(ctx, dateIndexR2Key(d))])),
    r2Competition: Object.fromEntries(dates.flatMap(d => (scenario.reportCompetitions || []).map(c => [`${c}/${d}`, r2Ids(ctx, competitionDateIndexR2Key(c, d))]))),
    coverage: Object.fromEntries(dates.map(d => [d, ctx.db.prepare('SELECT fixture_count FROM date_index_coverages WHERE date_jst=?').get(d)?.fixture_count ?? null])),
  }, null, 1));
});
