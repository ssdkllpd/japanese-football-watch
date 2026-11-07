import fs from 'node:fs';
import path from 'node:path';
import clientModule from '../api-football/client.js';
import plannerModule from './plan-manual-fixture-backfill.js';
import automationModule from './api-football-automation-plan.js';
import {remoteDatabase} from '../live/remote-d1.mjs';
import {readFixturePublishBudget} from '../../admin-worker/fixture-publish-budget.mjs';

const target=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
const policy=JSON.parse(fs.readFileSync('config/api-football-automation.json','utf8'));
const cupIds=new Set(JSON.parse(fs.readFileSync('config/cup-competitions.json','utf8')).competitions.map(c=>c.providerId));
const directory='.tmp/incident-audit';
fs.mkdirSync(path.join(directory,'seasons'),{recursive:true});
const database=remoteDatabase({account:process.env.CLOUDFLARE_ACCOUNT_ID,
  token:process.env.CLOUDFLARE_API_TOKEN,databaseId:target.d1DatabaseId,readOnly:true});
const inventory=[await database.prepare(`SELECT f.canonical_id,COUNT(*) OVER () AS total
  FROM fixtures f JOIN fixture_revisions r ON r.id=f.published_revision AND r.fixture_id=f.id
  WHERE r.lifecycle_state='published' ORDER BY f.canonical_id`).all()];
const dateInventory=[await database.prepare(`SELECT f.canonical_id,f.date_jst,f.kickoff_utc,f.status_short,
  c.canonical_id AS competition_id,h.canonical_id AS home_team_id,a.canonical_id AS away_team_id,
  COUNT(*) OVER () AS total FROM fixtures f
  JOIN competition_seasons s ON s.id=f.competition_season_id JOIN competitions c ON c.id=s.competition_id
  JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id ORDER BY f.canonical_id`).all()];
const dailyBudget=await readFixturePublishBudget({FOOTBALL_DB:database});
const underlying=clientModule.createClientFromEnv(process.env,{minimumIntervalMs:350,dailyReserve:1200});
const rawById=new Map();
const client={
  refreshDailyQuota:()=>underlying.refreshDailyQuota(),
  get lastQuota(){return underlying.lastQuota;},
  async get(endpoint,params){
    const result=await underlying.get(endpoint,params);
    if(endpoint==='fixtures'){
      fs.writeFileSync(path.join(directory,'seasons',`${params.league}.json`),JSON.stringify(result.data));
      for(const row of result.data.response||[])rawById.set(`af:fixture:${row.fixture.id}`,row);
    }
    return result;
  },
};
const plan=await plannerModule.planManualFixtureBackfill({policy,inventory,dateInventory,dailyBudget,
  client,preview:true,detailDailyCap:120});
const missing=plan.missingFixtureIds.map(id=>{
  const raw=rawById.get(id),fixture=automationModule.canonicalFixture(raw);
  return {fixtureId:id,competitionId:fixture.competitionId,kickoffUtc:fixture.kickoffUtc,
    dateJst:new Date(Date.parse(fixture.kickoffUtc)+9*3600000).toISOString().slice(0,10),
    status:fixture.status,teams:raw.teams};
});
const storedIds=new Set(dateInventory[0].results.map(row=>row.canonical_id));
const scopes=new Set(policy.competitionSeasons.map(c=>`af:competition:${c.league}`));
const isLeague=id=>scopes.has(id)&&!cupIds.has(Number(id.split(':').at(-1)));
const since=process.env.JFW_INCIDENT_SINCE||'2026-11-05';
if(!/^\d{4}-\d{2}-\d{2}$/.test(since)||!Number.isFinite(Date.parse(since)))throw new Error('Invalid incident audit date');
const missingByCompetition={};
for(const row of missing)missingByCompetition[row.competitionId]=(missingByCompetition[row.competitionId]||0)+1;
const report={schemaVersion:'jfw-missing-fixture-audit/1',checkedAt:new Date().toISOString(),
  configuredSeasons:policy.competitionSeasons.length,totalDiscoveredFixtureCount:plan.totalDiscoveredFixtureCount,
  finalFixtureCount:plan.finalFixtureCount,alreadyPublishedCount:plan.alreadyPublishedCount,
  deferredRecentCount:plan.deferredRecentCount,missingFixtureCount:missing.length,missingByCompetition,
  incidentSince:since,missingSinceIncident:missing.filter(row=>row.dateJst>=since),missing,
  newLeagueFixtures:[...rawById.entries()].filter(([id,raw])=>isLeague(`af:competition:${raw.league.id}`)&&!storedIds.has(id))
    .map(([fixtureId,raw])=>({fixtureId,fixture:raw.fixture,league:raw.league,teams:raw.teams})),
  storedLeagueFixturesMissingFromProvider:dateInventory[0].results.filter(row=>isLeague(row.competition_id)&&!rawById.has(row.canonical_id)),
  quota:client.lastQuota,dailyBudget};
fs.writeFileSync(path.join(directory,'plan.json'),JSON.stringify(plan));
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report));
fs.writeFileSync(path.join(directory,'published.json'),JSON.stringify(inventory));
fs.writeFileSync(path.join(directory,'stored-dates.json'),JSON.stringify(dateInventory));
console.log(JSON.stringify({...report,missing:undefined,missingSinceIncident:report.missingSinceIncident.length}));
