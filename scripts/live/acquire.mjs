import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadLiveTarget,ROOT} from './target.mjs';
import {remoteDatabase} from './remote-d1.mjs';
import {scheduledTick} from '../../live-worker/index.mjs';
export async function acquireOnce({env=process.env,request=fetch,now=Date.now(),paceMs=1000}={}) {
 const target=loadLiveTarget(),core=JSON.parse(fs.readFileSync(path.join(ROOT,'config/public-worker-target.json'),'utf8'));
 if(!target.acquisitionEnabled||target.acquisitionMode!=='github')return {status:'skipped_disabled'};
 const slot=Date.parse(env.LIVE_TRIGGER_SLOT);
 if(!Number.isSafeInteger(slot)||slot%60000!==0||slot>now+60000)throw new Error('Invalid live acquisition slot');
 if(now-slot>180000)return {status:'skipped_stale_slot'};
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 if(!/^[a-f0-9]{32}$/i.test(account||'')||!token||!env.API_FOOTBALL_KEY)throw new Error('Live runner credentials missing');
 const settings=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${target.workerName}/settings`,{
  headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!settings.ok)throw new Error('Live admission inspection failed');
 const body=await settings.json(),bindings=body.result?.bindings;
 if(body.success!==true||!Array.isArray(bindings))throw new Error('Live admission response invalid');
 if(!bindings.some(row=>row.name==='LIVE_ACQUISITION_ENABLED'&&row.text==='true')||!bindings.some(row=>row.name==='LIVE_ACQUISITION_MODE'&&row.text==='github'))return {status:'skipped_deployed_disabled'};
 const options={account,token,request};
 const runEnv={LIVE_DB:remoteDatabase({...options,databaseId:target.databaseId}),FOOTBALL_DB:remoteDatabase({...options,databaseId:core.d1DatabaseId,readOnly:true}),
  LIVE_ACQUISITION_ENABLED:'true',API_FOOTBALL_KEY:env.API_FOOTBALL_KEY,LIVE_COMPETITION_IDS:core.liveCompetitionIds.join(',')};
 let sent=0;
 const provider=async(url,init)=>{const delay=Math.max(0,sent+paceMs-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));sent=Date.now();return request(url,init);};
 const result=await scheduledTick({scheduledTime:slot},runEnv,provider,now);
 return {source:'github-actions',slot:new Date(slot).toISOString(),...result};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const report=await acquireOnce();fs.mkdirSync('.tmp/live-acquisition',{recursive:true});fs.writeFileSync('.tmp/live-acquisition/result.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report));
}
