import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { auditScheduleSync, affectedScheduleScopes } from './audit-fixture-schedule-sync.mjs';
import { dateIndexR2Key, competitionDateIndexR2Key } from '../../shared/date-index-contract.mjs';

export const SCHEDULE_INVENTORY_SQL = `SELECT fixture.canonical_id AS fixture_id,
  competition.canonical_id AS competition_id, season.canonical_id AS season_id,
  fixture.kickoff_utc, fixture.date_jst, fixture.status_short, fixture.status_long,
  fixture.status_elapsed, fixture.ingestion_state, fixture.published_revision,
  json_object('home',json_object('id',home.canonical_id,'providerId',home.provider_id,'name',home.name,'logo',home.logo_url,'winner',home_winner),
    'away',json_object('id',away.canonical_id,'providerId',away.provider_id,'name',away.name,'logo',away.logo_url,'winner',away_winner)) AS teams_json,
  json_object('goals',json_object('home',fixture.home_goals,'away',fixture.away_goals),
    'halftime',json_object('home',(SELECT home_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='halftime'),'away',(SELECT away_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='halftime')),'fulltime',json_object('home',(SELECT home_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='fulltime'),'away',(SELECT away_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='fulltime')),'extratime',json_object('home',(SELECT home_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='extratime'),'away',(SELECT away_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='extratime')),'penalty',json_object('home',(SELECT home_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='penalty'),'away',(SELECT away_value FROM fixture_score_parts WHERE fixture_id=fixture.id AND score_kind='penalty'))) AS score_json,
  json_object('id',competition.canonical_id,'providerId',competition.provider_id,'name',competition.name,
    'country',competition.country_name,'logo',competition.logo_url,'flag',competition.flag_url) AS competition_json,
  COUNT(*) OVER () AS total FROM fixtures fixture
  JOIN competition_seasons season ON season.id=fixture.competition_season_id
  JOIN competitions competition ON competition.id=season.competition_id
  JOIN teams home ON home.id=fixture.home_team_id JOIN teams away ON away.id=fixture.away_team_id
  ORDER BY fixture.canonical_id`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function d1AuditRows(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0]?.results)) throw new Error('D1 audit query failed.');
  return value[0].results;
}
async function main() {
  const [planFile, beforeFile, outputDirectory, option] = process.argv.slice(2);
  if (!planFile || !beforeFile || !outputDirectory || (option && option !== '--all')) throw new Error('Use PLAN BEFORE OUT [--all].');
  const auditToken=process.env.PUBLIC_DATE_AUDIT_TOKEN;
  if(typeof auditToken!=='string' || auditToken.length<32) throw new Error('Protected fresh audit token is required.');
  const plan = read(planFile);
  if (plan.schemaVersion !== 'jfw-fixture-schedule-plan/1' || !Array.isArray(plan.changes)) throw new Error('Schedule audit plan is invalid.');
  const changes = option === '--all' ? plan.changes : plan.changes.slice(0, 20);
  const root = path.resolve(outputDirectory);
  fs.mkdirSync(root, { recursive: true });
  const config = path.join(root, 'wrangler.toml');
  execFileSync(process.execPath, ['scripts/d1/render-admin-wrangler.mjs', '--output', config], { stdio: 'pipe' });
  const query = (name, sql) => {
    const data = execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', process.env.D1_DATABASE_NAME,
      '--remote', '--json', '--config', config, '--command', sql], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(root, `${name}.json`), data);
    return d1AuditRows(JSON.parse(data));
  };
  const before = d1AuditRows(read(beforeFile));
  const after = query('inventory', SCHEDULE_INVENTORY_SQL);
  const pendingSql = 'SELECT fixture_id,old_date_jst,new_date_jst,registered_dates_json,changed_at FROM fixture_schedule_refresh_pending ORDER BY fixture_id';
  const dateRepairSql = `SELECT q.date_jst,q.repair_token,
    (SELECT detail FROM date_index_repair_failures f WHERE f.date_jst=q.date_jst ORDER BY id DESC LIMIT 1) AS last_error
    FROM date_index_repair_queue q ORDER BY q.date_jst`;
  const pending = query('pending', pendingSql);
  const dateRepairs = query('date-repairs', dateRepairSql);
  const correctionSql = "SELECT target_canonical_id,field_path,status,applied_value_json FROM correction_states WHERE target_kind='fixture' AND (field_path LIKE 'fixture.status%' OR field_path LIKE 'fixture.teams%' OR field_path LIKE 'fixture.score%') ORDER BY target_canonical_id,field_path";
  const corrections = query('corrections', correctionSql);
  const genericCoverages = query('generic-coverages', 'SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages ORDER BY date_jst');
  const competitionCoverages = query('competition-coverages', 'SELECT c.canonical_id AS competition_id,coverage.date_jst,coverage.fixture_count,coverage.fixture_id_digest FROM competition_date_index_coverages coverage JOIN competitions c ON c.id=coverage.competition_id ORDER BY c.canonical_id,coverage.date_jst');
  const scopes = affectedScheduleScopes(changes, before, after);
  const r2 = {};
  for (const [scopeKey, scope] of scopes) {
    const key = scope.competitionId ? competitionDateIndexR2Key(scope.competitionId, scope.date) : dateIndexR2Key(scope.date);
    const file = path.join(root, `r2-${encodeURIComponent(scopeKey)}.json`);
    execFileSync('npx', ['--yes', 'wrangler@4', 'r2', 'object', 'get', `${process.env.R2_BUCKET}/${key}`, '--file', file, '--remote'], { stdio: 'pipe' });
    r2[scopeKey] = read(file);
  }
  const target = read('config/public-worker-target.json');
  const publicSamples = [];
  // Sample both generic and competition routes. A blocked read is an audit failure.
  const keys = [...scopes.keys()];
  const sampleKeys = [...new Set([keys.find(key => key.startsWith('all/')),
    keys.find(key => !key.startsWith('all/')), keys.at(-1)].filter(Boolean))];
  for (const scopeKey of sampleKeys) {
    const scope = scopes.get(scopeKey);
    const route = scope.competitionId ? `/api/v2/competitions/${encodeURIComponent(scope.competitionId)}/dates/${scope.date}` : `/api/v2/dates/${scope.date}`;
    const response = await fetch(new URL(`${route}?fresh=1`, target.workerOrigin), { headers: { Origin: target.appOrigin, 'x-jfw-audit-token':auditToken },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Public Worker read refused (${response.status}); audit incomplete.`);
    const sample = { scope: scopeKey, status: response.status, payload: await response.json() };
    fs.writeFileSync(path.join(root, `public-${encodeURIComponent(scopeKey)}.json`), `${JSON.stringify(sample)}\n`);
    publicSamples.push(sample);
  }
  const inventoryEnd = query('inventory-end', SCHEDULE_INVENTORY_SQL);
  if (JSON.stringify(query('corrections-end',correctionSql)) !== JSON.stringify(corrections)) throw new Error('Corrections changed during audit.');
  const pendingEnd = query('pending-end',pendingSql);
  const dateRepairsEnd = query('date-repairs-end',dateRepairSql);
  const report = auditScheduleSync({ changes, before, after, pending, genericCoverages,
    competitionCoverages, r2, publicSamples, inventoryEnd, corrections, dateRepairs, pendingEnd, dateRepairsEnd });
  fs.writeFileSync(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  // Preserve a completed affected-scope audit while keeping isolated failures visible.
  if (!report.overallPassed) {
    console.error('Affected-date audit passed; isolated repairs were observed. See report.json.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
