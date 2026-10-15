import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const repo='ssdkllpd/japanese-football-watch';
const expected='61d4dae0f9212aca65ce758bdbf0590e210bfb7e';
const root='.tmp/activation-confirmation';fs.mkdirSync(root,{recursive:true});
const report={schemaVersion:'jfw-activation-confirmation/1',startedAt:new Date().toISOString(),expectedMain:expected,switches:{schedule:process.env.SCHEDULE_ENABLED||'',results:process.env.RESULTS_ENABLED||''},runs:[],passed:false};
const save=()=>fs.writeFileSync(root+'/report.json',JSON.stringify(report,null,2)+'\n');
const api=route=>JSON.parse(execFileSync('gh',['api','repos/'+repo+'/'+route],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));
const pause=()=>new Promise(r=>setTimeout(r,15000));
async function verify(workflow,confirmation){
 assert.equal(api('git/ref/heads/main').object.sha,expected,'Main changed before dispatch');
 const route='actions/workflows/'+workflow+'/runs?event=workflow_dispatch&branch=main&per_page=30';
 const previous=new Set(api(route).workflow_runs.map(r=>r.id));
 const startedAt=Date.now();
 execFileSync('gh',['workflow','run',workflow,'--repo',repo,'--ref','main','-f','mode=execute','-f','confirmation='+confirmation],{encoding:'utf8',timeout:30000,stdio:'pipe'});
 const item={workflow,dispatchedAt:new Date(startedAt).toISOString(),runId:null,status:'awaiting_run',conclusion:null};report.runs.push(item);save();
 let run;
 for(let i=0;i<20;i++){
  const candidates=api(route).workflow_runs.filter(r=>!previous.has(r.id)&&r.head_sha===expected&&Date.parse(r.created_at)>=startedAt-10000);
  if(candidates.length>1)throw Error('Ambiguous concurrent manual dispatch; inspect run evidence');
  if(candidates.length===1){run=candidates[0];break;}
  await pause();
 }
 assert.ok(run,'Dispatched workflow run did not become visible');
 item.runId=run.id;item.url=run.html_url;save();console.log(JSON.stringify({workflow,runId:run.id,url:run.html_url}));
 const deadline=Date.now()+45*60000;
 while(Date.now()<deadline){
  run=api('actions/runs/'+item.runId);assert.equal(run.head_sha,expected);assert.equal(run.event,'workflow_dispatch');
  item.status=run.status;item.conclusion=run.conclusion;item.updatedAt=new Date().toISOString();save();
  if(run.status==='completed')break;
  await pause();
 }
 assert.equal(run.status,'completed','Workflow remained active past verification deadline');
 const jobs=api('actions/runs/'+item.runId+'/jobs?per_page=100').jobs;
 item.jobs=jobs.map(j=>({id:j.id,name:j.name,status:j.status,conclusion:j.conclusion}));save();
 assert.equal(run.conclusion,'success',workflow+' failed');
 assert.ok(jobs.length>0&&jobs.every(j=>j.conclusion==='success'),'A required job did not succeed');
 console.log(JSON.stringify({workflow,runId:run.id,passed:true,jobs:item.jobs}));
}
try{
 assert.equal(process.env.GITHUB_REPOSITORY,repo);
 assert.equal(report.switches.schedule,'true','Repository schedule variable must be true');
 assert.equal(report.switches.results,'true','Repository automation variable must be true');
 const policy=JSON.parse(fs.readFileSync('config/api-football-automation.json'));assert.equal(policy.scheduledSynchronizationEnabled,true);
 save();console.log(JSON.stringify({repositorySwitches:report.switches,policyEnabled:true}));
 await verify('api-football-schedule-sync.yml','RUN SCHEDULE SYNC');
 await verify('api-football-automation.yml','RUN API-FOOTBALL AUTOMATION');
 report.passed=true;report.completedAt=new Date().toISOString();save();console.log(JSON.stringify(report));
}catch(error){report.error=error.message;save();throw error;}
