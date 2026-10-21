'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{applyMigrations}=require('../scripts/d1/migration-inventory'),{createLocalD1}=require('../scripts/d1/local-d1');
const {normalizeFixtureBundle,fixtureIndexEntry}=require('../scripts/v2/fixture-contract');
const raw={fixture:{id:900001,date:'2026-10-21T12:00:00+00:00',status:{short:'FT',long:'Finished',elapsed:90}},league:{id:2,season:2026,name:'UEFA Champions League',country:'World',round:'League stage'},teams:{home:{id:1,name:'Club A'},away:{id:2,name:'Club B'}},goals:{home:1,away:0}};
async function setup(t){
 const db=new DatabaseSync(':memory:');applyMigrations(db,require('node:path').resolve(__dirname,'..'));t.after(()=>db.close());
 db.exec("INSERT INTO provider_sources(code,api_version) VALUES('api-football','v3'); INSERT INTO product_seasons(canonical_id,label,starts_on,ends_on) VALUES('jfw:season:2026-27','2026-27','2026-07-01','2027-06-30')");
 const bundle=normalizeFixtureBundle(raw,{fetchedAt:'2026-10-21T04:00:00.000Z',finalized:true});
 const value={schemaVersion:'jfw-cup-public-snapshot/1',competition:bundle.competition,season:{...bundle.season,startsOn:'2026-07-01',endsOn:'2026-12-31',status:'active'},generatedAt:bundle.fixture.reconciledAt,fixtures:[{...fixtureIndexEntry(bundle),round:'League stage'}],standings:null};
 const text=JSON.stringify(value),sha=crypto.createHash('sha256').update(text).digest('hex');
 const {cupDirectoryEntry}=await import('../shared/cup-snapshot-contract.mjs');
 const key=`football/v2/cups/snapshots/${sha}.json`,catalog={schemaVersion:'jfw-cup-catalog/1',competitions:[{...cupDirectoryEntry(value),snapshotKey:key,snapshotSha256:sha}]};
 const env={FOOTBALL_DB:createLocalD1(db),FOOTBALL_DATA:{get:async k=>({text:async()=>k.endsWith('catalog.json')?JSON.stringify(catalog):text})}};
 const request={schemaVersion:'jfw-d1-admin-ingest/1',operation:'cup_catalog_publish',competitionId:bundle.competition.id,seasonId:bundle.season.id,snapshotSha256:sha};
 return {db,env,request,bundle};
}
test('reviewed cup catalog initializes same-year metadata and reuses the normal protected final publisher',async t=>{
 const {db,env,request,bundle}=await setup(t),{publishCupCatalog}=await import('../admin-worker/cup-catalog-ingest.mjs');
 assert.equal((await publishCupCatalog(env,request)).imported,true);
 assert.equal((await publishCupCatalog(env,request)).imported,false);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM fixtures').get().n,0);
 const {publishFixtureFromR2}=await import('../admin-worker/fixture-ingest.mjs');
 const original=env.FOOTBALL_DATA.get;
 env.FOOTBALL_DATA.get=async key=>key.includes('/fixtures/')?{text:async()=>JSON.stringify(bundle)}:original(key);
 const report=await publishFixtureFromR2(env,{schemaVersion:'jfw-d1-admin-ingest/1',operation:'fixture_publish',fixtureId:bundle.fixture.id,competitionId:bundle.competition.id,seasonId:bundle.season.id,reuseStoredCatalog:true,requireStableDate:true,preserveCorrections:true,publicationSource:'automation',correctionDefinitions:{schemaVersion:'d1-fixture-correction-definitions/1',fixtureId:bundle.fixture.id,definitions:[]}});
 assert.equal(report.imported,true);
 assert.equal(db.prepare('SELECT publication_source FROM fixture_detail_publish_days').get().publication_source,'automation');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM fixture_revisions WHERE lifecycle_state=\'published\'').get().n,1);
 const worker=(await import('../worker/index.mjs')).default;
 env.APP_ORIGINS='https://app.test';env.D1_FIXTURE_DETAIL_ENABLED='true';
 const get=async suffix=>{const r=await worker.fetch(new Request('https://api.test/api/v2/'+suffix,{headers:{origin:'https://app.test'}}),env,{});assert.equal(r.status,200);return r.json();};
 const season=await get('competitions/af%3Acompetition%3A2/seasons/af%3Aseason%3A2%3A2026');
 assert.equal(season.degraded,false);assert.equal(season.fixtures[0].ingestionState,'finalized');assert.equal(season.fixtures[0].score.goals.home,1);
 assert.equal(season.summary.publishedDetailCount,1);assert.equal(season.cupSnapshot.automaticUpdates,true);
 const directory=await get('competitions');assert.equal(directory.competitions[0].seasons[0].summary.fixtureCount,1);
 assert.equal(directory.competitions[0].seasons[0].summary.publishedDetailCount,1);
 const date=await get('competitions/af%3Acompetition%3A2/dates/2026-10-21');assert.equal(date.fixtures[0].ingestionState,'finalized');
 const detail=await get('fixtures/af%3Afixture%3A900001');assert.equal(detail.fixture.ingestionState,'finalized');

});
test('cup catalog refuses unreviewed scopes and a changed publication source',async t=>{
 const {env,request}=await setup(t),{publishCupCatalog,assertCupCatalogRequest}=await import('../admin-worker/cup-catalog-ingest.mjs');
 assert.throws(()=>assertCupCatalogRequest({...request,competitionId:'af:competition:9999'}),/scope/);
 await assert.rejects(publishCupCatalog(env,{...request,snapshotSha256:'a'.repeat(64)}),/source changed/);
});
