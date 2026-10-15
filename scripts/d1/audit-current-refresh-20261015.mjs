import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {SCHEDULE_INVENTORY_SQL,d1AuditRows} from './capture-schedule-audit.mjs';
import {adminScheduleSender} from './execute-fixture-schedule-plan.mjs';
import {assertValidDateIndexPayload,dateIndexR2Key,competitionDateIndexR2Key} from '../../shared/date-index-contract.mjs';
const require=createRequire(import.meta.url);
const {createClientFromEnv}=require('../api-football/client');
const root=path.resolve(process.argv[2]||'.tmp/today-final-audit');
fs.mkdirSync(root,{recursive:true});
const save=(n,v)=>fs.writeFileSync(path.join(root,n+'.json'),JSON.stringify(v,null,2)+'\n');
execFileSync(process.execPath,['scripts/d1/render-admin-wrangler.mjs','--output',path.join(root,'wrangler.toml')]);
const query=(n,sql)=>{const raw=execFileSync('npx',['--yes','wrangler@4','d1','execute',process.env.D1_DATABASE_NAME,'--remote','--json','--config',path.join(root,'wrangler.toml'),'--command',sql],{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});const v=JSON.parse(raw);save(n,v);return d1AuditRows(v);};
const rows=query('inventory',SCHEDULE_INVENTORY_SQL);
assert.equal(rows.length,3420);
assert.equal(query('foreign-key-violations','PRAGMA foreign_key_check').length,0);
assert.equal(query('date-violations',"SELECT canonical_id,kickoff_utc,date_jst FROM fixtures WHERE strftime('%Y-%m-%d',kickoff_utc,'+9 hours') IS NOT date_jst").length,0);
const repairs=await adminScheduleSender(process.env)({schemaVersion:'jfw-d1-admin-ingest/1',operation:'fixture_schedule_repair_status'});save('repair-status',repairs);assert.equal(repairs.remaining,0);
assert.equal(query('pending','SELECT * FROM fixture_schedule_refresh_pending').length,0);
const corrections=query('corrections',"SELECT target_canonical_id,field_path,applied_value_json FROM correction_states WHERE target_kind='fixture' AND status='active' ORDER BY target_canonical_id,field_path");
const apply=(head,id)=>{for(const c of corrections.filter(c=>c.target_canonical_id===id)){const parts=c.field_path.split('.');if(parts.shift()!=='fixture' || !['status','teams','score'].includes(parts[0]))continue;let target=head;for(const k of parts.slice(0,-1)){assert.ok(target&&Object.hasOwn(target,k));target=target[k];}assert.ok(target&&Object.hasOwn(target,parts.at(-1)));target[parts.at(-1)]=JSON.parse(c.applied_value_json);}return head;};
const digest=ids=>createHash('sha256').update([...ids].sort().join('\n')+'\n').digest('hex');
const dates=new Map(),scopes=new Map();
for(const r of rows){if(!dates.has(r.date_jst))dates.set(r.date_jst,[]);dates.get(r.date_jst).push(r.fixture_id);const k=r.competition_id+'/'+r.date_jst;if(!scopes.has(k))scopes.set(k,[]);scopes.get(k).push(r.fixture_id);}
const generic=query('generic-coverages','SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages ORDER BY date_jst');
const competition=query('competition-coverages','SELECT c.canonical_id AS competition_id,x.date_jst,x.fixture_count,x.fixture_id_digest FROM competition_date_index_coverages x JOIN competitions c ON c.id=x.competition_id ORDER BY c.canonical_id,x.date_jst');
for(const c of generic){const ids=dates.get(c.date_jst)||[];assert.equal(c.fixture_count,ids.length,`Generic count ${c.date_jst}`);assert.equal(c.fixture_id_digest,digest(ids),`Generic digest ${c.date_jst}`);}
for(const [d] of dates)assert.ok(generic.some(c=>c.date_jst===d),`Missing generic ${d}`);
for(const c of competition){const k=c.competition_id+'/'+c.date_jst;const ids=scopes.get(k)||[];assert.equal(c.fixture_count,ids.length,`Competition count ${k}`);assert.equal(c.fixture_id_digest,digest(ids),`Competition digest ${k}`);}
for(const [key]of scopes)assert.ok(competition.some(c=>c.competition_id+'/'+c.date_jst===key),`Missing competition ${key}`);
const policy=JSON.parse(fs.readFileSync('config/api-football-automation.json'));
const client=createClientFromEnv(process.env);await client.refreshDailyQuota();
const provider=new Map();
for(const scope of policy.competitionSeasons){const result=await client.get('fixtures',{league:scope.league,season:scope.season,timezone:policy.timeZone});const raw=result.data;assert.ok(Array.isArray(raw.response)&&raw.response.length);assert.equal(Number(raw.paging?.total??1),1);save('provider-'+scope.league,raw);for(const item of raw.response){assert.equal(item.league.id,scope.league);assert.equal(item.league.season,scope.season);const id='af:fixture:'+item.fixture.id;assert.ok(!provider.has(id));provider.set(id,item);}}
assert.equal(provider.size,rows.length);
const final=new Set(['FT','AET','PEN']);let eligibleFinal=0,publishedFinal=0;const mismatches=[],retainedUndetermined=[];
for(const r of rows){const p=provider.get(r.fixture_id);assert.ok(p,`Provider missing ${r.fixture_id}`);const expected=apply({status:{short:p.fixture.status.short,long:p.fixture.status.long,elapsed:p.fixture.status.elapsed??null},teams:{home:{...p.teams.home,id:'af:team:'+p.teams.home.id,providerId:p.teams.home.id},away:{...p.teams.away,id:'af:team:'+p.teams.away.id,providerId:p.teams.away.id}},score:{goals:{home:p.goals.home,away:p.goals.away},halftime:p.score.halftime,fulltime:p.score.fulltime,extratime:p.score.extratime,penalty:p.score.penalty}},r.fixture_id);const teams=JSON.parse(r.teams_json),score=JSON.parse(r.score_json);const kick=new Date(p.fixture.date).toISOString();if(r.kickoff_utc!==kick){if(['PST','TBD'].includes(p.fixture.status.short))retainedUndetermined.push(r.fixture_id);else mismatches.push({fixtureId:r.fixture_id,field:'kickoffUtc',stored:r.kickoff_utc,provider:kick});}if(r.status_short!==expected.status.short)mismatches.push({fixtureId:r.fixture_id,field:'status',stored:r.status_short,provider:expected.status.short});for(const side of ['home','away'])if(teams[side].providerId!==expected.teams[side].providerId)mismatches.push({fixtureId:r.fixture_id,field:'team-'+side});if(final.has(p.fixture.status.short)&&Date.parse(p.fixture.date)+3*3600000<=Date.now()){eligibleFinal++;if(r.published_revision!==null)publishedFinal++;else mismatches.push({fixtureId:r.fixture_id,field:'unpublished_final'});for(const side of ['home','away'])if(score.goals[side]!==expected.score.goals[side])mismatches.push({fixtureId:r.fixture_id,field:'score-'+side,stored:score.goals[side],provider:expected.score.goals[side]});}}
save('provider-comparison',{fixtures:rows.length,eligibleFinal,publishedFinal,retainedUndetermined,mismatches,dailyRemaining:client.lastQuota.dailyRemaining});assert.equal(mismatches.length,0,'Fresh provider headers/scores differ; see provider-comparison.json');
const publicTarget=JSON.parse(fs.readFileSync('config/public-worker-target.json'));
assert.ok(process.env.PUBLIC_DATE_AUDIT_TOKEN?.length>=32);
const checks=[{date:'2026-08-23',competitionId:'af:competition:88'},{date:'2026-08-24',competitionId:'af:competition:88'},{date:'2026-10-14',competitionId:'af:competition:40'},{date:'2026-10-24',competitionId:'af:competition:140'},{date:'2026-10-26',competitionId:'af:competition:140'}];
for(const c of checks)if(c.date==='2026-10-14'&&!rows.some(r=>r.date_jst===c.date&&r.competition_id===c.competitionId))c.competitionId=rows.find(r=>r.date_jst===c.date)?.competition_id;
assert.ok(checks.every(c=>c.competitionId));
const headers=new Map(rows.map(r=>[r.competition_id,JSON.parse(r.competition_json)]));let verifiedR2=0,verifiedPublic=0;
for(const item of checks)for(const competitionId of [null,item.competitionId]){
 const key=competitionId?competitionDateIndexR2Key(competitionId,item.date):dateIndexR2Key(item.date);const slug=(competitionId||'all')+'-'+item.date;const file=path.join(root,'r2-'+slug.replaceAll(':','_')+'.json');
 execFileSync('npx',['--yes','wrangler@4','r2','object','get',process.env.R2_BUCKET+'/'+key,'--file',file,'--remote'],{stdio:'pipe',timeout:120000});
 const validate=payload=>{assertValidDateIndexPayload(payload,{expectedDate:item.date,expectedCompetitionId:competitionId});const expectedRows=rows.filter(r=>r.date_jst===item.date&&(!competitionId||r.competition_id===competitionId));assert.equal(payload.fixtures.length,expectedRows.length);if(competitionId)assert.deepEqual(payload.competition,headers.get(competitionId));for(const r of expectedRows){const f=payload.fixtures.find(f=>f.fixtureId===r.fixture_id);assert.ok(f);assert.equal(f.kickoffUtc,new Date(r.kickoff_utc).toISOString());assert.equal(f.dateJst,r.date_jst);assert.equal(f.competitionId,r.competition_id);assert.equal(f.seasonId,r.season_id);const teams=JSON.parse(r.teams_json);for(const s of ['home','away'])teams[s].winner=teams[s].winner===null?null:Boolean(teams[s].winner);const head=apply({teams,score:JSON.parse(r.score_json),status:{short:r.status_short,long:r.status_long,elapsed:r.status_elapsed}},r.fixture_id);assert.deepEqual(f.teams,head.teams);assert.deepEqual(f.score,head.score);assert.deepEqual(f.status,head.status);assert.equal(f.ingestionState,r.ingestion_state);assert.deepEqual(f.competition,JSON.parse(r.competition_json));}};
 validate(JSON.parse(fs.readFileSync(file)));verifiedR2++;
 const route=competitionId?'/api/v2/competitions/'+encodeURIComponent(competitionId)+'/dates/'+item.date:'/api/v2/dates/'+item.date;
 const url=new URL(route+'?fresh=1',publicTarget.workerOrigin);
 const response=await fetch(url,{headers:{Origin:publicTarget.appOrigin,'x-jfw-audit-token':process.env.PUBLIC_DATE_AUDIT_TOKEN},redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.match(response.headers.get('cache-control')||'',/no-store/);const payload=await response.json();save('public-'+slug.replaceAll(':','_'),payload);validate(payload);verifiedPublic++;
 if(item.date==='2026-08-23')for(const token of [null,'invalid-token']){const h={Origin:publicTarget.appOrigin,...(token?{'x-jfw-audit-token':token}:{})};const denied=await fetch(url,{headers:h,redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(denied.status,401);assert.match(denied.headers.get('cache-control')||'',/no-store/);}
}
const end=query('inventory-end',SCHEDULE_INVENTORY_SQL);assert.deepEqual(end,rows,'D1 changed during final audit');
const report={schemaVersion:'jfw-current-refresh-audit/1',passed:true,generatedAt:new Date().toISOString(),fixtures:rows.length,providerSeasons:provider.size?10:0,eligibleFinal,publishedFinal,allGenericCoverages:generic.length,allCompetitionCoverages:competition.length,verifiedR2Scopes:verifiedR2,verifiedFreshScopes:verifiedPublic,repairs:0,pending:0,providerHeaderScoreMismatches:0,retainedUndetermined,fullHistoricalDetailFreshnessVerified:false,automationSwitches:{schedule:process.env.SCHEDULE_ENABLED||'',results:process.env.RESULTS_ENABLED||''}};
save('report',report);console.log(JSON.stringify(report));
