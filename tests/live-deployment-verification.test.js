'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../scripts/live/verify-deployment.mjs'),'utf8').replace(/^import fs from 'node:fs';\n/,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function verify(rows) {
 let now=Date.parse('2026-10-16T10:00:00Z'),index=0;const start=now,reports=[],queries=[],exit={};
 const date=class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const fakeFs={readFileSync:()=>JSON.stringify({databaseId:'test-database',acquisitionEnabled:true}),writeFileSync:(_path,body)=>reports.push(JSON.parse(body))};
 const request=async(_url,options)=>{
  const {sql}=JSON.parse(options.body);queries.push(sql);assert.match(sql,/^SELECT /);
  const results=sql.includes('FROM live_control')?[rows(Math.min(index++,20),now,start)]:[];
  return {ok:true,json:async()=>({success:true,result:[{success:true,results}]})};
 };
 let error;
 try {await new AsyncFunction('fs','fetch','Date','process','console','setTimeout','AbortSignal',source)(fakeFs,request,date,
  {env:{CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'test-only'},exit(code){assert.equal(code,0);throw exit;}},
  {log(){}},(callback,delay)=>{now+=delay;callback();},AbortSignal);
 }catch(caught){if(caught!==exit)error=caught;}
 return {reports,queries,error};
}
const row=(now,extra={})=>({heartbeat_ms:now,last_success_ms:now,enabled:1,status:'idle',error_code:null,lease_until_ms:0,...extra});

test('activation recovers after transient completed failures and only reads production state',async()=>{
 const result=await verify((index,now)=>row(now,index<2?{status:'error',error_code:'provider_response_error',last_success_ms:0}:{}));
 assert.equal(result.error,undefined);assert.equal(result.reports.length,1);assert.equal(result.reports[0].passed,true);
});
test('three distinct completed failed ticks reject activation',async()=>{
 const result=await verify((_index,now)=>row(now,{status:'error',error_code:'provider_response_error',last_success_ms:0}));
 assert.match(result.error.message,/three ticks/);assert.equal(result.reports.length,0);
});
test('repeated polling of one failed tick is counted once',async()=>{
 const result=await verify((index,now,start)=>index<5?row(start,{status:'error',error_code:'provider_response_error',last_success_ms:0}):row(now));
 assert.equal(result.error,undefined);assert.equal(result.reports.length,1);
});
test('a new running lease does not count the previous error as a newly completed failure',async()=>{
 const result=await verify((index,now)=>row(now,index<5?{status:'error',last_success_ms:0,lease_until_ms:now+180000}:{}));
 assert.equal(result.error,undefined);assert.equal(result.reports.length,1);
});
test('a disabled Worker can never pass enabled activation verification',async()=>{
 const result=await verify((_index,now)=>row(now,{enabled:0,status:'disabled'}));
 assert.match(result.error.message,/timed out/);assert.equal(result.reports.length,0);
});
