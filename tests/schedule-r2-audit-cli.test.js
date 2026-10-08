// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): the audit CLI (scripts/d1/capture-schedule-audit.mjs) end to end.
// `npx wrangler` is replaced by a local shim that serves evidence dumped from a real-SQLite world;
// `fetch` is replaced by a stub that serves responses of the real public Worker handler. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, drain, setup, baseline, update, jst, tmpRoot } from './helpers/schedule-r2-harness.mjs';

const { affectedScheduleScopes } = await import(path.join(ROOT, 'scripts/d1/audit-fixture-schedule-sync.mjs'));
const { SCHEDULE_INVENTORY_SQL } = await import(path.join(ROOT, 'scripts/d1/capture-schedule-audit.mjs'));
const { dateIndexR2Key, competitionDateIndexR2Key } = await import(path.join(ROOT, 'shared/date-index-contract.mjs'));
const publicWorker = (await import(path.join(ROOT, 'worker/index.mjs'))).default;
const wr = r => JSON.stringify([{ success: true, results: r }]);
const q = (ctx, sql) => ctx.db.prepare(sql).all().map(r => ({ ...r }));

const SHIM = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const E = process.env.JFW_EVIDENCE; const a = process.argv.slice(2);
if (a.includes('d1')) {
  const sql = a[a.indexOf('--command') + 1];
  let name = sql.includes('date_index_repair_queue') ? 'date-repairs' : sql.includes('correction_states') ? 'corrections' : sql.includes('fixture_schedule_refresh_pending') ? 'pending' : sql.includes('competition_date_index_coverages') ? 'competition-coverages'
    : sql.includes('FROM date_index_coverages') ? 'generic-coverages' : 'inventory';
  if (['inventory','pending','date-repairs'].includes(name)) { const c = path.join(E, name + '.count'); const n = fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0;
    fs.writeFileSync(c, String(n + 1)); if (n >= 1 && fs.existsSync(path.join(E, name + '-end.json'))) name += '-end'; }
  process.stdout.write(fs.readFileSync(path.join(E, name + '.json'), 'utf8'));
} else if (a.includes('r2')) {
  const key = a[a.indexOf('get') + 1].split('/').slice(1).join('/'); const out = a[a.indexOf('--file') + 1];
  const src = path.join(E, 'r2', encodeURIComponent(key));
  if (!fs.existsSync(src)) { console.error('The specified key does not exist.'); process.exit(1); }
  fs.copyFileSync(src, out);
} else process.exit(2);
`;
const FETCH_STUB = `import fs from 'node:fs'; import path from 'node:path';
globalThis.fetch = async url => { const map = JSON.parse(fs.readFileSync(path.join(process.env.JFW_EVIDENCE, 'public.json'), 'utf8'));
  const hit = map[new URL(url).pathname]; if (!hit) return new Response('{"error":"Not found"}', { status: 404 });
  return new Response(JSON.stringify(hit.payload), { status: hit.status, headers: { 'content-type': 'application/json' } }); };
`;

async function dump() {
  const base = Date.parse('2026-11-10T10:00:00.000Z');
  const fixtures = [];
  for (let i = 0; i < 24; i += 1) fixtures.push({ id: 7000 + i, league: i % 2 ? 140 : 39, kickoff: new Date(base + (i % 4) * 86400000 + (i % 3) * 3600000).toISOString() });
  fixtures.push({ id: 7900, league: 48, kickoff: new Date(base + 86400000 + 1800000).toISOString() });
  const ctx = setup(fixtures);
  const changes = [0, 1, 2].map(i => ({ schemaVersion: 'jfw-d1-admin-ingest/1', ...update(fixtures[i].id, fixtures[i].league, fixtures[i].kickoff,
    new Date(Date.parse(fixtures[i].kickoff) + 86400000 + 5400000).toISOString()) }));
  await baseline(ctx, [...new Set([...fixtures.map(f => jst(f.kickoff)), ...changes.map(c => jst(c.newKickoffUtc))])].sort());
  const E = tmpRoot('audit-cli'); fs.mkdirSync(path.join(E, 'r2'));
  const before = q(ctx, SCHEDULE_INVENTORY_SQL);
  fs.writeFileSync(path.join(E, 'before.json'), wr(before));
  fs.writeFileSync(path.join(E, 'plan.json'), JSON.stringify({ schemaVersion: 'jfw-fixture-schedule-plan/1', changes, held: [] }));
  for (const c of changes) { const { schemaVersion, ...p } = c; assert.equal((await ctx.send(p)).status, 200); assert.equal((await drain(ctx)).status, 200); }
  const after = q(ctx, SCHEDULE_INVENTORY_SQL);
  fs.writeFileSync(path.join(E,'date-repairs.json'),wr(q(ctx,'SELECT date_jst,repair_token FROM date_index_repair_queue ORDER BY date_jst')));
  fs.writeFileSync(path.join(E,'corrections.json'),wr(q(ctx,"SELECT target_canonical_id,field_path,status,applied_value_json FROM correction_states WHERE target_kind='fixture' AND (field_path LIKE 'fixture.status%' OR field_path LIKE 'fixture.teams%' OR field_path LIKE 'fixture.score%') ORDER BY target_canonical_id,field_path")));
  fs.writeFileSync(path.join(E, 'inventory.json'), wr(after));
  fs.writeFileSync(path.join(E, 'pending.json'), wr(q(ctx, 'SELECT fixture_id,old_date_jst,new_date_jst,changed_at FROM fixture_schedule_refresh_pending')));
  fs.writeFileSync(path.join(E, 'generic-coverages.json'), wr(q(ctx, 'SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages ORDER BY date_jst')));
  fs.writeFileSync(path.join(E, 'competition-coverages.json'), wr(q(ctx, 'SELECT c.canonical_id AS competition_id,coverage.date_jst,coverage.fixture_count,coverage.fixture_id_digest FROM competition_date_index_coverages coverage JOIN competitions c ON c.id=coverage.competition_id ORDER BY c.canonical_id,coverage.date_jst')));
  const scopes = affectedScheduleScopes(changes, before, after); const pub = {};
  const env = { ...ctx.env, APP_ORIGINS: 'https://ssdkllpd.github.io', D1_DATE_INDEX_ENABLED: 'true', D1_COMPETITION_DATE_INDEX_ENABLED: 'true' };
  for (const [, scope] of scopes) {
    const key = scope.competitionId ? competitionDateIndexR2Key(scope.competitionId, scope.date) : dateIndexR2Key(scope.date);
    fs.writeFileSync(path.join(E, 'r2', encodeURIComponent(key)), ctx.objects.get(key));
    const route = scope.competitionId ? `/api/v2/competitions/${encodeURIComponent(scope.competitionId)}/dates/${scope.date}` : `/api/v2/dates/${scope.date}`;
    const res = await publicWorker.fetch(new Request(`https://w.test${route}`, { headers: { Origin: 'https://ssdkllpd.github.io' } }), env, { waitUntil() {} });
    pub[route] = { status: res.status, payload: await res.json() };
  }
  fs.writeFileSync(path.join(E, 'public.json'), JSON.stringify(pub));
  return { E, scopes };
}
function run(E) {
  const bin = path.join(E, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npx'), SHIM, { mode: 0o755 }); fs.writeFileSync(path.join(E, 'fetch-stub.mjs'), FETCH_STUB);
  for (const name of ['inventory','pending','date-repairs']) fs.rmSync(path.join(E, name + '.count'), { force: true });
  fs.rmSync(path.join(E, 'out'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['--import', path.join(E, 'fetch-stub.mjs'), 'scripts/d1/capture-schedule-audit.mjs', path.join(E, 'plan.json'), path.join(E, 'before.json'), path.join(E, 'out')], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { PATH: `${bin}:${process.env.PATH}`, JFW_EVIDENCE: E, NODE_OPTIONS: '', ADMIN_WORKER_NAME: 'w', R2_BUCKET: 'bucket', PUBLIC_DATE_AUDIT_TOKEN:'a'.repeat(32),
      D1_DATABASE_NAME: 'db', D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000' } });
  const evidence = fs.existsSync(path.join(E, 'out')) ? fs.readdirSync(path.join(E, 'out')).length : 0;
  const reportFile=path.join(E,'out','report.json');
  return { code: r.status, out: r.stdout.trim().slice(0, 160), err: r.stderr.trim().split('\n').pop().slice(0, 160), evidenceFiles: evidence,
    report:fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):null };
}
const mutate = (E, name, fn) => { const f = path.join(E, name); const v = JSON.parse(fs.readFileSync(f, 'utf8')); fn(v); fs.writeFileSync(f, JSON.stringify(v)); };

test('C audit CLI: PASS on consistent evidence, non-zero exit on refused public read, missing R2 object, tampered R2, moving inventory, failed D1 query', async () => {
  const out = {};
  { const { E } = await dump(); out.C0_consistent = run(E); }
  { const { E } = await dump(); mutate(E, 'public.json', m => { for (const k of Object.keys(m)) m[k].status = 403; }); out.C1_public_403 = run(E); }
  { const { E } = await dump(); fs.rmSync(path.join(E, 'public.json')); fs.writeFileSync(path.join(E, 'public.json'), '{}'); out.C1_public_404 = run(E); }
  { const { E } = await dump(); const f = fs.readdirSync(path.join(E, 'r2')).at(-1); fs.rmSync(path.join(E, 'r2', f)); out.C2_r2_object_missing = run(E); }
  { const { E } = await dump(); const f = fs.readdirSync(path.join(E, 'r2')).find(n => !n.includes('competition')); mutate(E, path.join('r2', f), p => { p.fixtures[0].status.short = 'PST'; }); out.C3_r2_tampered = run(E); }
  { const { E } = await dump(); fs.copyFileSync(path.join(E, 'inventory.json'), path.join(E, 'inventory-end.json')); mutate(E, 'inventory-end.json', v => { v[0].results[5].status_short = 'CANC'; }); out.C4_inventory_moved_during_audit = run(E); }
  { const { E } = await dump(); fs.writeFileSync(path.join(E, 'generic-coverages.json'), JSON.stringify([{ success: false, results: [] }])); out.C5_d1_query_failed = run(E); }
  { const { E } = await dump(); mutate(E, 'pending.json', v => { v[0].results.push({ fixture_id: 'af:fixture:7000', old_date_jst: '2026-11-10', new_date_jst: '2026-11-11', changed_at: 'x' }); }); out.C6_pending_left = run(E); }
  console.log('C evidence', JSON.stringify(out, null, 1));
  assert.equal(out.C0_consistent.code, 0, out.C0_consistent.err);
  for (const k of Object.keys(out).filter(k => k !== 'C0_consistent')) assert.notEqual(out[k].code, 0, k);
});

test('R4 real capture CLI saves a complete affected-scope audit before exiting nonzero for isolated dates',async()=>{
  const {E}=await dump();
  mutate(E,'date-repairs.json',v=>v[0].results.push({date_jst:'2026-12-01',repair_token:'bad',last_error:'Investigate orphan'}));
  mutate(E,'pending.json',v=>v[0].results.push({fixture_id:'af:fixture:99999',old_date_jst:'2026-12-01',
    new_date_jst:'2026-12-02',registered_dates_json:'["2026-12-01","2026-12-02"]'}));
  const result=run(E);
  assert.equal(result.code,1);assert.equal(result.report?.passed,true);
  assert.equal(result.report.overallPassed,false);assert.equal(result.report.verifiedChanges,3);
  assert.ok(result.report.verifiedR2Scopes>0);assert.ok(result.report.verifiedPublicSamples>0);
  assert.equal(result.report.isolatedDateRepairs[0].date_jst,'2026-12-01');
  assert.equal(result.report.isolatedPendingRepairs[0].fixture_id,'af:fixture:99999');
});
test('R4 capture CLI tolerates an unrelated queue change during collection but rejects a new affected repair',async()=>{
  const {E}=await dump();
  fs.writeFileSync(path.join(E,'date-repairs-end.json'),wr([{date_jst:'2026-12-03',repair_token:'new'}]));
  const isolated=run(E);assert.equal(isolated.code,1);assert.equal(isolated.report?.passed,true);
  assert.equal(isolated.report.isolatedDateRepairs[0].stage,'final');
  fs.writeFileSync(path.join(E,'date-repairs-end.json'),wr([{date_jst:'2026-11-11',repair_token:'new'}]));
  const affected=run(E);assert.equal(affected.code,1);assert.equal(affected.report,null);
  assert.match(affected.err,/Affected date repair queue/);
});
