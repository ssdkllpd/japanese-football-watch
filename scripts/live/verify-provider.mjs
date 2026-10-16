import fs from 'node:fs';
import {providerSession} from '../../live-worker/index.mjs';
import {allowedLeagues,providerFixture} from '../../shared/live-contract.mjs';
const target=JSON.parse(fs.readFileSync('.tmp/live/target.json','utf8'));
if(!target.acquisitionEnabled) {console.log('Provider live probe skipped while disabled');process.exit(0);}
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!token||!process.env.API_FOOTBALL_KEY) throw new Error('Live probe credentials missing');
let writes=0;
function statement(sql,params=[]) {
  const execute=async()=>{
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${target.databaseId}/query`,{
      method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({sql,params}),redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error(`Live probe database HTTP ${response.status}`);
    const body=await response.json(),result=body.result?.[0];
    if(body.success!==true||result?.success!==true) throw new Error('Live probe database read failed');
    writes+=Number(result.meta?.rows_written??0);return result;
  };
  return {bind:(...values)=>statement(sql,values),all:execute,run:execute};
}
const now=Date.now(),db={prepare:sql=>statement(sql)};
const session=await providerSession({LIVE_DB:db,API_FOOTBALL_KEY:process.env.API_FOOTBALL_KEY},now);
// A deployment-only wire probe. It never writes fixtures or synthetic heartbeats.
const body=await session.read('/fixtures',{live:'all',timezone:'Asia/Tokyo'});
const publicTarget=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
const allowed=allowedLeagues({LIVE_COMPETITION_IDS:publicTarget.liveCompetitionIds.join(',')});
const selected=body.response.map(row=>providerFixture(row,allowed)).filter(Boolean);
await db.prepare('UPDATE live_budget SET rows_written=rows_written+? WHERE utc_day=?').bind(writes+1,session.day).run();
const report={passed:true,verifiedAt:new Date().toISOString(),endpoint:'fixtures?live=all',requests:session.calls,
  returnedFixtures:body.response.length,configuredLeagueFixtures:selected.length,remaining:session.remaining,productionSnapshotsWritten:0};
fs.writeFileSync('.tmp/live/provider-verification.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report));
