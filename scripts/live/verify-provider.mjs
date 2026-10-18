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
const detailIds=[...new Set([...selected.map(row=>Number(row.fixtureId.split(':')[2])),...upcoming.results.map(row=>row.provider_id)])].slice(0,20);
const detailSections=[];
if (detailIds.length) {
  const details=await session.read('/fixtures',{ids:detailIds.join('-')});
  const ids=new Set();
  for (const raw of details.response) {
    if (!detailIds.includes(raw.fixture?.id) || ids.has(raw.fixture.id)) throw new Error('Live detail probe scope differs');
    ids.add(raw.fixture.id);
    const bundle=providerDetail(raw,allowed,now);
    if (!bundle) throw new Error('Live detail probe league differs');
    detailSections.push({fixtureId:bundle.fixture.id,status:bundle.fixture.status.short,
      lineups:bundle.lineups.length,events:bundle.events.length,teamStats:bundle.teamStats.length,playerStats:bundle.playerStats.length});
  }
  if (ids.size!==detailIds.length) throw new Error('Live detail probe fixtures missing');
}
await db.prepare('UPDATE live_budget SET rows_written=rows_written+? WHERE utc_day=?').bind(counter.rows+1,session.day).run();
const report={passed:true,verifiedAt:new Date().toISOString(),endpoint:'fixtures?live=all',requests:session.calls,
  returnedFixtures:body.response.length,configuredLeagueFixtures:selected.length,detailSections,remaining:session.remaining,productionSnapshotsWritten:0};
fs.writeFileSync('.tmp/live/provider-verification.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report));
