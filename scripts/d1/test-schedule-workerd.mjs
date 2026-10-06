// Real workerd D1 regression. All storage is local; R2 is a fault-injectable map.
// Install the pinned CI dependency in an isolated prefix and set JFW_WRANGLER_MODULE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { handleAdminIngest } from '../../admin-worker/index.mjs';
import { buildD1DateIndexesForPublication } from '../../worker/index.mjs';
import { publishDateIndexCoverageFromR2 } from '../../admin-worker/date-index-coverage-ingest.mjs';
import { executeAutomationAdminPlan } from './execute-automation-admin-plan.mjs';
import { dateIndexR2Key, competitionDateIndexR2Key } from '../../shared/date-index-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const modulePath = process.env.JFW_WRANGLER_MODULE || 'wrangler';
const { getPlatformProxy } = require(modulePath);
const wranglerRoot = path.dirname(require.resolve(`${modulePath}/package.json`));
assert.equal(JSON.parse(fs.readFileSync(path.join(wranglerRoot,'package.json'))).version, '4.147.0');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-workerd-schedule-'));
const configPath = path.join(temp,'wrangler.toml');
const state = path.join(temp,'state');
fs.writeFileSync(configPath, `name = "jfw-schedule-local-test"\ncompatibility_date = "2026-09-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "probe"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = ${JSON.stringify(path.join(root,'migrations'))}\n`);
const childEnv = { ...process.env, WRANGLER_SEND_METRICS:'false', NODE_OPTIONS:'' };
for (const name of Object.keys(childEnv)) if (/^(CLOUDFLARE_|API_FOOTBALL_|ADMIN_INGEST_)/.test(name)) delete childEnv[name];
const cli = args => execFileSync(process.execPath,[path.join(wranglerRoot,'bin/wrangler.js'),...args,'--config',configPath,'--local','--persist-to',state],
  { cwd:temp,env:childEnv,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024 });
let proxy;
try {
  cli(['d1','migrations','apply','probe']);
  const seed = path.join(temp,'seed.sql');
  fs.writeFileSync(seed, `
INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on) VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type) VALUES(1,'af:competition:39',1,39,'PL','England','League');
INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status) VALUES(1,'af:season:39:2026',1,1,2026,'2026','active');
INSERT INTO teams(id,canonical_id,source_id,provider_id,name) VALUES(1,'af:team:40',1,40,'Home'),(2,'af:team:50',1,50,'Away');
INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state) VALUES('af:fixture:9101',1,9101,1,1,2,'2026-11-10T10:00:00.000Z','2026-11-10','NS','Not Started','scheduled'),('af:fixture:9102',1,9102,1,1,2,'2026-11-10T12:00:00.000Z','2026-11-10','NS','Not Started','scheduled');
`);
  cli(['d1','execute','probe','--file',seed]);
  process.env.WRANGLER_SEND_METRICS = 'false';
  proxy = await getPlatformProxy({ configPath,persist:{path:path.join(state,'v3')} });
  const objects = new Map();
  const batches = [];
  let failKey;
  const database = { prepare:sql=>proxy.env.DB.prepare(sql), async batch(statements) {
    const result = await proxy.env.DB.batch(statements);
    batches.push(result.map(row=>({success:row.success,changes:row.meta.changes})));
    return result;
  } };
  const env = { ADMIN_INGEST_TOKEN:'local-test',FOOTBALL_DB:database, FOOTBALL_DATA:{
    async get(key) { const raw=objects.get(key);return raw===undefined?null:{text:async()=>raw}; },
    async put(key,value) { if(key===failKey) { failKey=null;throw new Error('Injected local R2 interruption'); } objects.set(key,value); }
  } };
  const send = async payload => {
    const response = await handleAdminIngest(new Request('https://offline.test/admin/v1/ingest',{
      method:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify({schemaVersion:'jfw-d1-admin-ingest/1',...payload}) }),env);
    return { status:response.status,body:await response.json() };
  };
  const upd = (id,oldKickoffUtc,newKickoffUtc) => ({operation:'fixture_schedule_update',fixtureId:`af:fixture:${id}`,
    competitionId:'af:competition:39',seasonId:'af:season:39:2026',oldKickoffUtc,newKickoffUtc,oldStatus:'NS',newStatus:'NS'});
  const repair = async () => {
    for(let i=0;i<100;i+=1) {
      const result=await send({operation:'fixture_schedule_repair'});
      assert.equal(result.status,200,JSON.stringify(result));
      if(result.body.report.repaired===null) return result;
    }
    throw new Error('Local workerd repair did not drain');
  };
  const ids = key => JSON.parse(objects.get(key)).fixtures.map(item=>item.fixtureId);
  const count = async table => (await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  const seedIndexes = async () => {
    for(const date of ['2026-11-10','2026-11-11']) {
      const built=await buildD1DateIndexesForPublication(env,date,['af:competition:39']);
      objects.set(dateIndexR2Key(date),JSON.stringify(built.generic));
      for(const c of built.competitions) objects.set(competitionDateIndexR2Key(c.competition.id,date),JSON.stringify(c));
      await publishDateIndexCoverageFromR2(env,{operation:'date_index_coverage_publish',date,competitionIds:['af:competition:39']});
    }
  };
  await seedIndexes();
  const same=await send(upd(9102,'2026-11-10T12:00:00.000Z','2026-11-10T13:00:00.000Z'));
  assert.equal(same.status,200,JSON.stringify(same));
  const sameBatch=batches.at(-1);
  await repair();
  const cross=await send(upd(9101,'2026-11-10T10:00:00.000Z','2026-11-11T10:00:00.000Z'));
  assert.equal(cross.status,200,JSON.stringify(cross));
  const crossBatch=batches.at(-1);
  assert.ok(crossBatch[1].changes>1,'workerd must include trigger writes in meta.changes');
  assert.equal(await count('date_index_coverages'),0);
  failKey=competitionDateIndexR2Key('af:competition:39','2026-11-10');
  const failed=await send({operation:'fixture_schedule_repair'});
  assert.equal(failed.status,422);
  assert.equal(await count('fixture_schedule_refresh_pending'),1);
  assert.ok(await count('date_index_repair_queue')>0);
  await repair();
  assert.deepEqual(ids(dateIndexR2Key('2026-11-10')),['af:fixture:9102']);
  assert.deepEqual(ids(dateIndexR2Key('2026-11-11')),['af:fixture:9101']);
  assert.deepEqual(ids(competitionDateIndexR2Key('af:competition:39','2026-11-10')),['af:fixture:9102']);
  assert.deepEqual(ids(competitionDateIndexR2Key('af:competition:39','2026-11-11')),['af:fixture:9101']);
  assert.equal(await count('fixture_schedule_refresh_pending'),0);
  assert.equal(await count('date_index_repair_queue'),0);
  const stale=await send(upd(9101,'2026-11-10T10:00:00.000Z','2026-11-12T10:00:00.000Z'));
  assert.equal(stale.status,422);
  assert.equal(await count('fixture_schedule_refresh_pending'),0);
  assert.equal((await database.prepare("SELECT date_jst FROM fixtures WHERE canonical_id='af:fixture:9101'").first()).date_jst,'2026-11-11');
  // Exercise the real result UPSERT against existing repair scopes as well.
  const {writeFixtureEnvelope}=require(path.join(root,'scripts/v2/fetch-fixture-vertical-slice.js'));
  const {createAutomationAdminPlan}=require(path.join(root,'scripts/d1/create-api-football-automation-admin-plan.js'));
  const raw={fixture:{id:9101,date:'2026-11-12T10:00:00.000Z',status:{short:'FT',long:'Match Finished',elapsed:90}},
    league:{id:39,season:2026,name:'PL',country:'England'},teams:{home:{id:40,name:'Home'},away:{id:50,name:'Away'}},
    goals:{home:1,away:0},score:{},events:[],lineups:[],players:[],statistics:[]};
  const artifactRoot=path.join(temp,'artifacts');
  const artifactDir=path.join(artifactRoot,'fixtures','9101');
  writeFixtureEnvelope(artifactDir,{fixture:raw,quota:{}},{finalized:true,fetchedAt:'2026-11-12T13:00:00.000Z'});
  const bundle=fs.readFileSync(path.join(artifactDir,'fixture.json'),'utf8');
  objects.set('football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:9101.json',bundle);
  const planDirectory=path.join(temp,'plan');fs.mkdirSync(planDirectory);
  const plan=createAutomationAdminPlan({schemaVersion:'jfw-api-football-automation-plan/1',detailFetches:[{
    fixtureId:'af:fixture:9101',providerFixtureId:9101,competitionId:'af:competition:39',seasonId:'af:season:39:2026',previousDateJst:'2026-11-11'
  }],standingsFetches:[]},artifactRoot,planDirectory);
  failKey=competitionDateIndexR2Key('af:competition:39','2026-11-11');
  const publish=() => executeAutomationAdminPlan(plan,{url:'https://offline.test',token:'local-test',planDirectory,
    fetchImpl:(url,init)=>handleAdminIngest(new Request(url,init),env)});
  const partial=await publish();assert.equal(partial.passed,false,'R2 failure after result D1 commit must be visible');
  assert.ok(await count('date_index_repair_queue')>0);
  const retried=await publish();assert.equal(retried.passed,true,JSON.stringify(retried));
  assert.deepEqual(ids(dateIndexR2Key('2026-11-11')),[]);
  assert.deepEqual(ids(competitionDateIndexR2Key('af:competition:39','2026-11-11')),[]);
  assert.deepEqual(ids(dateIndexR2Key('2026-11-12')),['af:fixture:9101']);
  assert.equal(await count('date_index_repair_queue'),0);
  console.log(JSON.stringify({passed:true,runtime:'wrangler 4.147.0 / workerd local D1',sameBatch,crossBatch,
    checks:['same date success','cross-date trigger writes success','partial R2 retry convergence','stale compare-and-swap refusal','result UPSERT and interrupted relocation retry'],remoteWrites:0}));
} finally { if(proxy) await proxy.dispose();fs.rmSync(temp,{recursive:true,force:true}); }
