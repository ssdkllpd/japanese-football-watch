import {jstDate,MINUTE,precheckStage,liveEligible} from '../shared/live-contract.mjs';
import {scheduleDiscoveryDue,scheduledTick,LIMITS} from './index.mjs';
const BASE='https://api.github.com/repos/ssdkllpd/japanese-football-watch/actions/workflows/api-football-live.yml';
async function rows(db,sql,...params) {
 const result=await db.prepare(sql).bind(...params).all();
 if(result.success===false||!Array.isArray(result.results))throw new Error('live_dispatch_database_failed');
 return result.results;
}
export async function dispatchLiveTick(event,env,request=fetch,now=Date.now()) {
 if(env.LIVE_ACQUISITION_ENABLED!=='true')return scheduledTick(event,env,request,now);
 if(!env.LIVE_DB||!env.FOOTBALL_DB||!env.WORKFLOW_DISPATCH_TOKEN)throw new Error('live_dispatch_configuration_missing');
 const db=env.LIVE_DB,day=new Date(now).toISOString().slice(0,10),slot=Math.floor((event.scheduledTime??now)/MINUTE)*MINUTE;
 const control=(await rows(db,'SELECT * FROM live_control WHERE id=1'))[0];
 if(!control)throw new Error('live_control_missing');
 if(slot<=control.last_tick_ms)return {status:'already_completed_or_running'};
 const inventory=await rows(db,'SELECT * FROM live_schedule WHERE kickoff_ms>=? ORDER BY kickoff_ms LIMIT 1001',now-6*3600000);
 if(inventory.length>1000)throw new Error('schedule_inventory_limit');
 const budget=(await rows(db,'SELECT * FROM live_budget WHERE utc_day=?',day))[0];
 const paused=budget&&(budget.requests>=LIMITS.dailyRequests||budget.rows_written>=LIMITS.dailyRows-10000||(budget.remaining!==null&&budget.remaining<=LIMITS.reserve+LIMITS.perTickRequests));
 const needs=await scheduleDiscoveryDue(env,now)||control.daily_day!==jstDate(now)||!control.last_core_sync_ms||now-control.last_core_sync_ms>=15*MINUTE
  ||inventory.some(row=>precheckStage(row,now)||liveEligible(row,now));
 // Idle and budget-paused ticks stay local and make no provider requests.
 if(!needs||paused)return scheduledTick(event,env,request,now);
 const headers={authorization:`Bearer ${env.WORKFLOW_DISPATCH_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json',
  'x-github-api-version':'2026-03-10','user-agent':'jfw-live-dispatcher'};
 const response=await request(`${BASE}/runs?branch=main&per_page=100`,{headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('live_run_inspection_failed');
 const payload=await response.json();if(!Array.isArray(payload.workflow_runs))throw new Error('live_run_response_invalid');
 if(payload.workflow_runs.some(run=>run.status!=='completed'))return {status:'deferred_busy'};
 const claim=await rows(db,"INSERT INTO live_dispatch_slots(slot_ms,attempted_ms,state) VALUES(?,?,'attempting') ON CONFLICT(slot_ms) DO NOTHING RETURNING slot_ms",slot,now);
 if(!claim.length)return {status:'already_attempted'};
 let state='uncertain',http=null,runId=null;
 try {
  const dispatched=await request(`${BASE}/dispatches`,{method:'POST',headers,redirect:'manual',signal:AbortSignal.timeout(10000),
   body:JSON.stringify({ref:'main',inputs:{confirmation:'RUN LIVE ACQUISITION',scheduled_slot:new Date(slot).toISOString()}})});
  http=dispatched.status;state=[200,201,204].includes(http)?'accepted':'rejected';
  if(http===200||http===201){const body=await dispatched.json().catch(()=>null);if(Number.isSafeInteger(body?.workflow_run_id))runId=body.workflow_run_id;}
 }catch{}
 const results=await db.batch([
  db.prepare('UPDATE live_dispatch_slots SET state=?,http_status=?,run_id=? WHERE slot_ms=?').bind(state,http,runId,slot),
  db.prepare('DELETE FROM live_dispatch_slots WHERE slot_ms<?').bind(now-7*86400000),
 ]);
 const writes=1+results.reduce((n,result)=>n+Number(result.meta?.rows_written??result.meta?.changes??0),0);
 await db.prepare('INSERT INTO live_budget(utc_day,rows_written) VALUES(?,?) ON CONFLICT(utc_day) DO UPDATE SET rows_written=rows_written+excluded.rows_written').bind(day,writes+1).run();
 const report={liveDispatch:true,status:state,slot:new Date(slot).toISOString(),httpStatus:http,runId};console.log(JSON.stringify(report));
 if(state!=='accepted')throw new Error('live_workflow_dispatch_failed');
 return report;
}
