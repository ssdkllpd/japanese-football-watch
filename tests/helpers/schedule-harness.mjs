// Regression harness adapted from the user-supplied independent Claude reproduction.
// Real node:sqlite with the repository migrations; R2 is an in-memory map with
// per-key fault injection. Expectations in the tests are written from explicit
// inputs, never from planner / refresh output.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createLocalD1 } = require(path.join(ROOT, 'scripts/d1/local-d1.js'));
const { applyMigrations } = require(path.join(ROOT, 'scripts/d1/migration-inventory.js'));

export const { handleAdminIngest } = await import(path.join(ROOT, 'admin-worker/index.mjs'));
export const { buildD1DateIndexesForPublication, buildD1DateFeed } = await import(path.join(ROOT, 'worker/index.mjs'));
export const { publishDateIndexCoverageFromR2 } = await import(path.join(ROOT, 'admin-worker/date-index-coverage-ingest.mjs'));
export const { dateIndexR2Key, competitionDateIndexR2Key } = await import(path.join(ROOT, 'shared/date-index-contract.mjs'));

export const COMPS = { 39: 1, 140: 2, 48: 3 }; // provider league -> competitions.id

// fixtures: [{ id, league, kickoff, status='NS' }]
export function setup(fixtures) {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, ROOT);
  db.exec(`
    INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
    INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on)
      VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
    INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type) VALUES
      (1,'af:competition:39',1,39,'Premier League','England','League'),
      (2,'af:competition:140',1,140,'La Liga','Spain','League'),
      (3,'af:competition:48',1,48,'League Cup','England','Cup');
    INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status) VALUES
      (1,'af:season:39:2026',1,1,2026,'2026','active'),
      (2,'af:season:140:2026',2,1,2026,'2026','active'),
      (3,'af:season:48:2026',3,1,2026,'2026','active');
    INSERT INTO teams(id,canonical_id,source_id,provider_id,name)
      VALUES(1,'af:team:40',1,40,'Home'),(2,'af:team:50',1,50,'Away');
  `);
  const insert = db.prepare(`INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,
      home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state)
      VALUES(?,1,?,?,1,2,?,?,?,?,'scheduled')`);
  for (const f of fixtures) {
    insert.run(`af:fixture:${f.id}`, f.id, COMPS[f.league], f.kickoff, jst(f.kickoff), f.status || 'NS',
      f.status === 'PST' ? 'Postponed' : 'Not Started');
  }
  const objects = new Map();
  const faults = { failPutKeys: new Set(), putLog: [] };
  const env = {
    ADMIN_INGEST_TOKEN: 't', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) { const v = objects.get(key); return v === undefined ? null : { async text() { return v; } }; },
      async put(key, value) {
        if (faults.failPutKeys.has(key)) { faults.failPutKeys.delete(key); throw new Error(`injected R2 put failure ${key}`); }
        faults.putLog.push(key); objects.set(key, value);
      },
    },
  };
  const send = async payload => {
    const response = await handleAdminIngest(new Request('https://offline.test/admin/v1/ingest', {
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1', ...payload }),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, objects, faults, send };
}

// Independent JST date: fixed +9h offset arithmetic (Japan has no DST).
export function jst(utc) {
  return new Date(Date.parse(utc) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// Publish initial R2 indexes + coverage for the given dates (baseline state).
export async function baseline(ctx, dates) {
  for (const date of dates) {
    const built = await buildD1DateIndexesForPublication(ctx.env, date, []);
    ctx.objects.set(dateIndexR2Key(date), JSON.stringify(built.generic));
    for (const c of built.competitions) {
      ctx.objects.set(competitionDateIndexR2Key(c.competition.id, date), JSON.stringify(c));
    }
    await publishDateIndexCoverageFromR2(ctx.env, { schemaVersion: 'jfw-d1-admin-ingest/1',
      operation: 'date_index_coverage_publish', date,
      competitionIds: built.competitions.map(c => c.competition.id) });
  }
}

export function update(id, league, oldKickoffUtc, newKickoffUtc, oldStatus = 'NS', newStatus = 'NS') {
  return { operation: 'fixture_schedule_update', fixtureId: `af:fixture:${id}`,
    competitionId: `af:competition:${league}`, seasonId: `af:season:${league}:2026`,
    oldKickoffUtc, newKickoffUtc, oldStatus, newStatus };
}

export function r2Ids(ctx, key) {
  const raw = ctx.objects.get(key);
  return raw === undefined ? undefined : JSON.parse(raw).fixtures.map(f => f.fixtureId);
}
export function r2Payload(ctx, key) {
  const raw = ctx.objects.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
}
export async function feedOrError(ctx, date, competitionId = null) {
  try { const f = await buildD1DateFeed(ctx.env, date, competitionId); return f ? { ids: f.fixtures.map(x => x.fixtureId), feed: f } : { ids: null }; }
  catch (e) { return { error: e.message }; }
}
export function pendingRows(ctx) {
  return ctx.db.prepare('SELECT fixture_id, old_date_jst, new_date_jst FROM fixture_schedule_refresh_pending ORDER BY fixture_id').all()
    .map(r => ({ ...r }));
}
export function fixtureRow(ctx, id) {
  const r = ctx.db.prepare('SELECT kickoff_utc, date_jst, status_short, published_revision FROM fixtures WHERE canonical_id = ?')
    .get(`af:fixture:${id}`);
  return r ? { ...r } : null;
}

export async function drain(ctx) {
  let result;
  for (let i=0;i<100;i+=1) {
    result=await ctx.send({operation:'fixture_schedule_repair'});
    if (result.status!==200 || result.body.report?.repaired===null) return result;
  }
  throw new Error('Regression repair failed to drain in 100 actual Admin requests.');
}
