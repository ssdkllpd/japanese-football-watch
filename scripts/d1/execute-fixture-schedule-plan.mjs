import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPaidBackfillCapacity } from './check-paid-backfill-capacity.mjs';
import { drainDateRepairs } from './drain-date-repairs.mjs';

export function adminScheduleSender(env, fetchImpl = fetch) {
  const endpoint = new URL(env.ADMIN_INGEST_URL);
  if(endpoint.protocol!=='https:' || endpoint.username || endpoint.password || !env.ADMIN_INGEST_TOKEN) throw new Error('Protected Admin endpoint is required.');
  endpoint.pathname='/admin/v1/ingest';endpoint.search='';endpoint.hash='';
  return async request => {
    const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${env.ADMIN_INGEST_TOKEN}`,
      'content-type':'application/json'},body:JSON.stringify(request)});
    const body=await response.json().catch(()=>null);
    if(!response.ok || body?.ok!==true) throw new Error(`Schedule ${request.operation} failed (${response.status}): ${body?.detail || 'unknown'}`);
    return body.report;
  };
}
const dateJst = value => new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10);

export async function executeSchedulePlan(plan, send, {all=false, capacityCheck=()=>checkPaidBackfillCapacity(process.env)} = {}) {
  if(plan.schemaVersion!=='jfw-fixture-schedule-plan/1' || !Array.isArray(plan.changes)
    || (all && plan.changes.length>240)) throw new Error('Invalid schedule plan.');
  const selected=all ? plan.changes : plan.changes.slice(0,20);
  const successful=[],failed=[];
  for(const [index,request] of selected.entries()) {
    // Account limits are a global stop, not an isolated data error.
    if(index%20===0) await capacityCheck();
    try {
      const scope={fixtureId:request.fixtureId,dates:[...new Set([dateJst(request.oldKickoffUtc),dateJst(request.newKickoffUtc)])]};
      const before=await drainDateRepairs(send,scope);
      if(!before.passed) throw new Error(`Affected date repairs are incomplete: ${JSON.stringify(before)}`);
      await send(request);
      const after=await drainDateRepairs(send,scope);
      if(!after.passed) throw new Error(`Schedule repair remains incomplete: ${JSON.stringify(after)}`);
      successful.push(request.fixtureId);
    } catch(error) {
      failed.push({fixtureId:request.fixtureId,detail:String(error.message)});
    }
  }
  return {passed:failed.length===0,updated:successful.length,successful,failed,
    remaining:plan.changes.length-successful.length,held:(plan.held || []).length};
}

async function main() {
  const [mode,...args]=process.argv.slice(2);
  const send=adminScheduleSender(process.env);
  if(mode==='repair') {
    const soft=args.includes('--continue-on-error');
    const reportIndex=args.indexOf('--report');
    const reportPath=reportIndex<0 ? null : args[reportIndex+1];
    if(args.some((arg,i)=> !['--continue-on-error','--report'].includes(arg) && !(reportIndex>=0 && i===reportIndex+1))
      || (reportIndex>=0 && (!reportPath || reportPath.startsWith('--')))) throw new Error('Invalid repair options.');
    const report=await drainDateRepairs(send);
    if(reportPath) {fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`);}
    console.log(JSON.stringify(report));
    if(!report.passed && !soft) process.exitCode=1;
    return;
  }
  const [planFile,option]=args;
  if(mode!=='execute' || !planFile || args.length>2 || (option && option!=='--all')) throw new Error('Use repair or execute PLAN.json [--all].');
  const report=await executeSchedulePlan(JSON.parse(fs.readFileSync(planFile,'utf8')),send,{all:option==='--all'});
  console.log(JSON.stringify(report));
  if(!report.passed) process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(`Error: ${error.message}`);process.exitCode=1;});
}
