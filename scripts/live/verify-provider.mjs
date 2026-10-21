import fs from 'node:fs';
import {remoteDatabase} from './remote-d1.mjs';
import {providerSession,countedDatabase} from '../../live-worker/index.mjs';
import {allowedLeagues,providerFixture} from '../../shared/live-contract.mjs';
import {providerDetail} from '../../shared/live-detail.mjs';
const target=JSON.parse(fs.readFileSync('.tmp/live/target.json','utf8'));
if(!target.acquisitionEnabled) {console.log('Provider live probe skipped while disabled');process.exit(0);}
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!token||!process.env.API_FOOTBALL_KEY) throw new Error('Live probe credentials missing');
const now=Date.now(),counter={rows:0};
const db=countedDatabase(remoteDatabase({account,token,databaseId:target.databaseId}),counter);
const session=await providerSession({LIVE_DB:db,API_FOOTBALL_KEY:process.env.API_FOOTBALL_KEY},now);
// A deployment-only wire probe. It never writes fixtures or synthetic heartbeats.
const body=await session.read('/fixtures',{live:'all',timezone:'Asia/Tokyo'});
const publicTarget=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
const allowed=allowedLeagues({LIVE_COMPETITION_IDS:publicTarget.liveCompetitionIds.join(',')});
const selected=body.response.map(row=>providerFixture(row,allowed)).filter(Boolean);
const upcoming=await db.prepare("SELECT provider_id FROM live_schedule WHERE status='NS' AND kickoff_ms>=? AND kickoff_ms<=? ORDER BY kickoff_ms LIMIT 20").bind(now-600000,now+3600000).all();
// Exercise a real completed UEFA cup even when no European match is live at deployment.
const cupConfig=JSON.parse(fs.readFileSync('config/cup-competitions.json','utf8'));
let cupFixture=null;
if(cupConfig.acquisitionEnabled) {
  const cup=cupConfig.competitions.find(c=>c.providerId===2);
  const route=`/api/v2/competitions/${encodeURIComponent(cup.id)}/seasons/${encodeURIComponent(`af:season:${cup.providerId}:${cupConfig.providerSeason}`)}`;
  const response=await fetch(publicTarget.workerOrigin+route,{headers:{origin:publicTarget.appOrigin},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Cup detail probe schedule is unavailable');
  const season=await response.json();
  cupFixture=(season.fixtures||[]).filter(f=>f.competitionId===cup.id&&['FT','AET','PEN'].includes(f.status?.short))
    .sort((a,b)=>b.kickoffUtc.localeCompare(a.kickoffUtc))[0];
  if(!cupFixture)throw new Error('Cup detail probe has no acquired completed fixture');
}
const detailIds=[...new Set([...(cupFixture?[Number(cupFixture.fixtureId.split(':')[2])]:[]),...selected.map(row=>Number(row.fixtureId.split(':')[2])),...upcoming.results.map(row=>row.provider_id)])].slice(0,20);
const detailSections=[];
if (detailIds.length) {
  const details=await session.read('/fixtures',{ids:detailIds.join('-')});
  const ids=new Set();
  for (const raw of details.response) {
    if (!detailIds.includes(raw.fixture?.id) || ids.has(raw.fixture.id)) throw new Error('Live detail probe scope differs');
    ids.add(raw.fixture.id);
    const bundle=providerDetail(raw,allowed,now);
    if (!bundle) throw new Error('Live detail probe league differs');
    detailSections.push({fixtureId:bundle.fixture.id,competitionId:bundle.fixture.competitionId,status:bundle.fixture.status.short,
      lineups:bundle.lineups.length,events:bundle.events.length,teamStats:bundle.teamStats.length,playerStats:bundle.playerStats.length});
  }
  if (ids.size!==detailIds.length) throw new Error('Live detail probe fixtures missing');
}
await db.prepare('UPDATE live_budget SET rows_written=rows_written+? WHERE utc_day=?').bind(counter.rows+1,session.day).run();
const report={passed:true,verifiedAt:new Date().toISOString(),endpoint:'fixtures?live=all',requests:session.calls,
  returnedFixtures:body.response.length,configuredCompetitionCount:allowed.size,configuredLeagueFixtures:selected.length,cupProbeFixture:cupFixture?.fixtureId||null,detailSections,remaining:session.remaining,productionSnapshotsWritten:0};
fs.writeFileSync('.tmp/live/provider-verification.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report));
