import {dispatchLiveTick} from './dispatch.mjs';
import { LIVE_STATUSES, CLOSED_STATUSES, MINUTE, jstDate, allowedLeagues, providerFixture, isCandidate, precheckStage, liveEligible } from '../shared/live-contract.mjs';

export const LIMITS = Object.freeze({ reserve:1200, dailyRequests:4000, dailyRows:100000, maxFixtures:240, perTickRequests:12 });
const API='https://v3.football.api-sports.io';
const scalar = n => n===null || n==='' ? null : (/^\d+$/.test(String(n)) ? Number(n) : null);
const chunks = rows => Array.from({length:Math.ceil(rows.length/20)},(_,i)=>rows.slice(i*20,i*20+20));
async function all(db,sql,...params) {
  const result=await db.prepare(sql).bind(...params).all();
  if(result.success===false || !Array.isArray(result.results)) throw new Error('live_database_read_failed');
  return result.results;
}
export async function providerSession(env, now, request=fetch) {
  const db=env.LIVE_DB, day=new Date(now).toISOString().slice(0,10);
  await db.prepare('INSERT OR IGNORE INTO live_budget(utc_day) VALUES(?)').bind(day).run();
  const budget=(await all(db,'SELECT * FROM live_budget WHERE utc_day=?',day))[0];
  if (budget.rows_written>=LIMITS.dailyRows-10000) throw new Error('live_write_budget');
  if (budget.remaining!==null && budget.remaining<=LIMITS.reserve+LIMITS.perTickRequests) throw new Error('quota_reserved');
  if(budget.requests>=LIMITS.dailyRequests) throw new Error('live_request_budget');
  if(!env.API_FOOTBALL_KEY) throw new Error('live_configuration_missing');
  let remaining=null, calls=0, minuteRemaining=null;
  const started=Date.now();
  const read=async (endpoint,parameters={},status=false) => {
    if(!status && (remaining===null || remaining<=LIMITS.reserve+LIMITS.perTickRequests)) throw new Error('quota_reserved');
    if(minuteRemaining!==null && minuteRemaining<=1) throw new Error('provider_minute_limit');
    if(calls>=LIMITS.perTickRequests) throw new Error('tick_request_limit');
    const claim=await all(db,'UPDATE live_budget SET requests=requests+1 WHERE utc_day=? AND requests<? RETURNING requests',day,LIMITS.dailyRequests);
    if(!claim.length) throw new Error('live_request_budget');
    calls++;
    if(Date.now()-started>60000) throw new Error('tick_time_limit');
    if(env.LEASE_OWNER) {
      const lease=await all(db,'UPDATE live_control SET lease_until_ms=? WHERE id=1 AND lease_owner=? RETURNING id',now+(Date.now()-started)+180000,env.LEASE_OWNER);
      if(!lease.length) throw new Error('lease_lost');
    }
    const url=new URL(endpoint,API);
    for(const [key,value] of Object.entries(parameters)) url.searchParams.set(key,String(value));
    const response=await request(url.toString(),{headers:{'x-apisports-key':env.API_FOOTBALL_KEY},redirect:'manual',signal:AbortSignal.timeout(8000)});
    // Never follow a provider redirect with the API key.
    const headerRemaining=scalar(response.headers.get('x-ratelimit-requests-remaining'));
    minuteRemaining=scalar(response.headers.get('x-ratelimit-remaining'));
    if(headerRemaining!==null) {
      remaining=headerRemaining;
      await db.prepare('UPDATE live_budget SET remaining=?,checked_ms=? WHERE utc_day=?').bind(remaining,now,day).run();
    }
    if(!response.ok) throw new Error(response.status===429?'provider_rate_limited':'provider_http_error');
    const body=await response.json();
    if(body?.errors && (Array.isArray(body.errors)?body.errors.length:Object.keys(body.errors).length)) {
      const detail=JSON.stringify(body.errors).split(String(env.API_FOOTBALL_KEY)).join('[redacted]').slice(0,600);
      await db.batch([
        db.prepare('INSERT INTO live_provider_errors(at_ms,endpoint,http_status,error_detail) VALUES(?,?,?,?)').bind(now,url.pathname,response.status,detail),
        db.prepare('DELETE FROM live_provider_errors WHERE id NOT IN (SELECT id FROM live_provider_errors ORDER BY id DESC LIMIT 100)'),
      ]);
      throw new Error('provider_response_error');
    }
    if(status) {
      const used=scalar(body?.response?.requests?.current), limit=scalar(body?.response?.requests?.limit_day);
      if(!Number.isSafeInteger(used)||!Number.isSafeInteger(limit)||used<0||limit<used) throw new Error('provider_quota_unknown');
      remaining=Math.min(headerRemaining??Infinity,limit-used);
      await db.prepare('UPDATE live_budget SET remaining=?,checked_ms=? WHERE utc_day=?').bind(remaining,now,day).run();
    } else {
      if(headerRemaining===null) throw new Error('provider_quota_unknown');
      if(!Array.isArray(body.response)||body.response.length>10000 || (body.paging?.total??1)>1) throw new Error('provider_payload_incomplete');
    }
    return body;
  };
  await read('/status',{},true);
  return { read, day, get remaining(){return remaining;}, get calls(){return calls;} };
}
async function saveSchedule(env,dto,now,{stage=null,snapshot=false,seen=false,resetMissing=false,coreKickoff=null}={}) {
  const db=env.LIVE_DB, id=Number(dto.fixtureId.split(':')[2]),league=Number(dto.competitionId.split(':')[2]);
  const kickoff=Date.parse(dto.kickoffUtc),payload=JSON.stringify(dto);
  const commands=[db.prepare(`INSERT INTO live_schedule(fixture_id,provider_id,competition_id,kickoff_ms,status,payload,last_check_ms,last_seen_ms,core_kickoff_ms)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(fixture_id) DO UPDATE SET kickoff_ms=excluded.kickoff_ms,status=excluded.status,payload=excluded.payload,
    check_2h_ms=CASE WHEN live_schedule.kickoff_ms<>excluded.kickoff_ms THEN NULL WHEN ?='2h' THEN excluded.last_check_ms ELSE live_schedule.check_2h_ms END,
    check_1h_ms=CASE WHEN live_schedule.kickoff_ms<>excluded.kickoff_ms THEN NULL WHEN ?='1h' THEN excluded.last_check_ms ELSE live_schedule.check_1h_ms END,
    missing_since_ms=CASE WHEN ?=1 THEN NULL WHEN ?=1 AND live_schedule.missing_since_ms IS NOT NULL THEN excluded.last_check_ms ELSE live_schedule.missing_since_ms END,
    last_seen_ms=CASE WHEN ?=1 THEN excluded.last_check_ms ELSE live_schedule.last_seen_ms END,
    core_kickoff_ms=COALESCE(excluded.core_kickoff_ms,live_schedule.core_kickoff_ms),
    last_check_ms=excluded.last_check_ms WHERE excluded.last_check_ms>=COALESCE(live_schedule.last_check_ms,0)`)
    .bind(dto.fixtureId,id,league,kickoff,dto.status.short,payload,now,seen?now:null,coreKickoff,stage,stage,seen?1:0,resetMissing?1:0,seen?1:0)];
  if(snapshot) commands.push(db.prepare(`INSERT INTO live_snapshots(fixture_id,payload,updated_ms) VALUES(?,?,?)
    ON CONFLICT(fixture_id) DO UPDATE SET payload=excluded.payload,updated_ms=excluded.updated_ms
    WHERE excluded.updated_ms>=live_snapshots.updated_ms`).bind(dto.fixtureId,payload,now));
  await db.batch(commands);
}
async function refreshIds(env,session,rows,now,allowed,stages=null) {
  for(const part of chunks(rows)) {
    const response=await session.read('/fixtures',{ids:part.map(row=>row.provider_id).join('-')});
    const expected=new Map(part.map(row=>[row.fixture_id,row]));
    const seen=new Set();
    for(const raw of response.response) {
      const dto=providerFixture(raw,allowed);
      if(!dto || !expected.has(dto.fixtureId) || seen.has(dto.fixtureId)) throw new Error('schedule_scope_mismatch');
      seen.add(dto.fixtureId);
      await saveSchedule(env,dto,now,{stage:stages?.get(dto.fixtureId),snapshot:liveEligible(expected.get(dto.fixtureId),now)||CLOSED_STATUSES.has(dto.status.short),resetMissing:true});
    }
    if(seen.size!==expected.size) throw new Error('schedule_fixture_missing');
  }
}
async function seedCore(env,now,allowed) {
  const rows=await all(env.FOOTBALL_DB,`SELECT f.provider_id,c.provider_id AS competition_id,cs.provider_season,
    f.kickoff_utc,f.status_short,f.status_long,f.status_elapsed,f.home_goals,f.away_goals,f.ingestion_state,
    h.provider_id AS home_id,h.name AS home_name,h.logo_url AS home_logo,
    a.provider_id AS away_id,a.name AS away_name,a.logo_url AS away_logo
    FROM fixtures f JOIN competition_seasons cs ON cs.id=f.competition_season_id JOIN competitions c ON c.id=cs.competition_id
    JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
    WHERE f.kickoff_utc>=? AND f.kickoff_utc<=? ORDER BY f.kickoff_utc LIMIT 1001`,new Date(now-6*3600000).toISOString(),new Date(now+48*3600000).toISOString());
  if(rows.length>1000) throw new Error('core_inventory_limit');
  const known=new Map((await all(env.LIVE_DB,'SELECT fixture_id,core_kickoff_ms,status FROM live_schedule')).map(row=>[row.fixture_id,row]));
  for(const row of rows) {
    if(!allowed.has(row.competition_id)) continue;
    // Never overwrite newer provider changes with the four-hour core inventory.
    const prior=known.get(`af:fixture:${row.provider_id}`),coreKickoff=Date.parse(row.kickoff_utc);
    if(prior?.core_kickoff_ms===null) {
      await env.LIVE_DB.prepare('UPDATE live_schedule SET core_kickoff_ms=? WHERE fixture_id=?').bind(coreKickoff,prior.fixture_id).run();
      if(row.ingestion_state!=='finalized') continue;
    }
    if(prior && prior.core_kickoff_ms===coreKickoff && !(row.ingestion_state==='finalized' && prior.status!==row.status_short)) continue;
    const dto=providerFixture({fixture:{id:row.provider_id,date:row.kickoff_utc,status:{short:row.status_short,long:row.status_long,elapsed:row.status_elapsed}},
      league:{id:row.competition_id,season:row.provider_season},teams:{home:{id:row.home_id,name:row.home_name,logo:row.home_logo},away:{id:row.away_id,name:row.away_name,logo:row.away_logo}},goals:{home:row.home_goals,away:row.away_goals}},allowed);
    if(dto) await saveSchedule(env,dto,now,{coreKickoff,snapshot:row.ingestion_state==='finalized'});
  }
}
async function runTick(env,now,request) {
  const db=env.LIVE_DB,allowed=allowedLeagues(env),day=jstDate(now);
  const control=(await all(db,'SELECT * FROM live_control WHERE id=1'))[0];
  const daily=control.daily_day!==day;
  // Follow newly committed core schedule changes without spending provider calls.
  if(!control.last_core_sync_ms || now-control.last_core_sync_ms>=15*MINUTE) {
    await seedCore(env,now,allowed);
    await db.prepare('UPDATE live_control SET last_core_sync_ms=? WHERE id=1').bind(now).run();
  }
  let rows=await all(db,'SELECT * FROM live_schedule WHERE kickoff_ms>=? ORDER BY kickoff_ms LIMIT 1001',now-6*3600000);
  if(rows.length>1000) throw new Error('schedule_inventory_limit');
  const needs=rows.some(row=>precheckStage(row,now)||liveEligible(row,now));
  if(!daily && !needs) {
    const next=rows.filter(row=>isCandidate(row,now)).map(row=>row.kickoff_ms-3600000);
    return {status:'idle',nextStart:next.length?Math.min(...next):null};
  }
  const session=await providerSession(env,now,request);
  if(daily) {
    for(const date of [day,jstDate(now+86400000)]) {
      const checked=(await all(db,'SELECT checked_ms FROM live_date_checks WHERE date_jst=?',date))[0];
      if(checked && jstDate(checked.checked_ms)===day) continue;
      const body=await session.read('/fixtures',{date,timezone:'Asia/Tokyo'});
      for(const raw of body.response) {const dto=providerFixture(raw,allowed);if(dto) await saveSchedule(env,dto,now);}
      await db.prepare('INSERT INTO live_date_checks VALUES(?,?) ON CONFLICT(date_jst) DO UPDATE SET checked_ms=excluded.checked_ms').bind(date,now).run();
    }
    await db.prepare('UPDATE live_control SET daily_day=? WHERE id=1').bind(day).run();
    await db.batch([
      db.prepare('DELETE FROM live_snapshots WHERE updated_ms<?').bind(now-2*86400000),
      db.prepare('DELETE FROM live_schedule WHERE kickoff_ms<?').bind(now-3*86400000),
      db.prepare('DELETE FROM live_budget WHERE utc_day<?').bind(new Date(now-7*86400000).toISOString().slice(0,10)),
      db.prepare('DELETE FROM live_date_checks WHERE date_jst<?').bind(jstDate(now-3*86400000)),
    ]);
  }
  rows=await all(db,'SELECT * FROM live_schedule WHERE kickoff_ms>=? ORDER BY kickoff_ms LIMIT 1001',now-6*3600000);
  const stages=new Map(rows.map(row=>[row.fixture_id,precheckStage(row,now)]).filter(([,stage])=>stage));
  if(stages.size) await refreshIds(env,session,rows.filter(row=>stages.has(row.fixture_id)),now,allowed,stages);
  rows=await all(db,'SELECT * FROM live_schedule WHERE kickoff_ms>=? ORDER BY kickoff_ms LIMIT 1001',now-6*3600000);
  let active=rows.filter(row=>liveEligible(row,now));
  if(active.length>LIMITS.maxFixtures) throw new Error('live_fixture_limit');
  const absent=active.filter(row=>row.missing_since_ms!==null && now-row.missing_since_ms>=30*MINUTE);
  if(absent.length) {
    await refreshIds(env,session,absent,now,allowed);
    rows=await all(db,'SELECT * FROM live_schedule WHERE kickoff_ms>=? ORDER BY kickoff_ms LIMIT 1001',now-6*3600000);
    active=rows.filter(row=>liveEligible(row,now));
  }
  if(!active.length) {
    const next=rows.filter(row=>isCandidate(row,now)).map(row=>row.kickoff_ms-3600000);
    return {status:'idle',nextStart:next.length?Math.min(...next):null,providerCalls:session.calls};
  }
  const body=await session.read('/fixtures',{live:'all',timezone:'Asia/Tokyo'});
  const selected=new Map(active.map(row=>[row.fixture_id,row])),seen=new Set();
  for(const raw of body.response) {
    const dto=providerFixture(raw,allowed);
    if(!dto || !selected.has(dto.fixtureId)) continue;
    if(seen.has(dto.fixtureId)) throw new Error('duplicate_live_fixture');
    seen.add(dto.fixtureId);
    await saveSchedule(env,dto,now,{snapshot:true,seen:true});
  }
  const disappeared=active.filter(row=>!seen.has(row.fixture_id) && row.last_seen_ms!==null);
  // A game disappearing from live=all may have just finished. Confirm once;
  // otherwise a goal/FT transition could remain stale for thirty minutes.
  if(disappeared.length) await refreshIds(env,session,disappeared,now,allowed);
  for(const row of active.filter(row=>!seen.has(row.fixture_id))) {
    await db.prepare('UPDATE live_schedule SET missing_since_ms=COALESCE(missing_since_ms,?),last_seen_ms=NULL WHERE fixture_id=?').bind(now,row.fixture_id).run();
  }
  await db.prepare('UPDATE live_control SET last_poll_ms=? WHERE id=1').bind(now).run();
  return {status:'polling',nextStart:null,providerCalls:session.calls,liveFixtures:seen.size};
}
// Measure D1's actual billed write metadata instead of guessing from SQL changes.
export function countedDatabase(db,counter) {
  const native=new WeakMap();
  const record=result=>{ counter.rows+=Number(result?.meta?.rows_written??result?.meta?.changes??0);return result; };
  const wrap=stmt=>{
    const proxy={ bind(...args){return wrap(stmt.bind(...args));},async all(){return record(await stmt.all());},async run(){return record(await stmt.run());} };
    native.set(proxy,stmt);return proxy;
  };
  return {prepare:sql=>wrap(db.prepare(sql)),async batch(statements){const results=await db.batch(statements.map(stmt=>native.get(stmt)));results.forEach(record);return results;} };
}
export async function scheduledTick(event,env,request=fetch,now=Date.now()) {
  if(!env.LIVE_DB) throw new Error('live_database_missing');
  const counter={rows:0};
  env={...env,LIVE_DB:countedDatabase(env.LIVE_DB,counter)};
  const tick=Math.floor((event.scheduledTime??now)/MINUTE)*MINUTE,owner=crypto.randomUUID();
  const claimed=await all(env.LIVE_DB,`UPDATE live_control SET lease_owner=?,lease_until_ms=?,last_tick_ms=?,heartbeat_ms=?,enabled=?
    WHERE id=1 AND lease_until_ms<? AND last_tick_ms<? RETURNING id`,owner,now+180000,tick,now,env.LIVE_ACQUISITION_ENABLED==='true'?1:0,now,tick);
  if(!claimed.length) return {status:'duplicate_or_busy'};
  env.LEASE_OWNER=owner;
  let result,error;
  try {
    if(env.LIVE_ACQUISITION_ENABLED!=='true') result={status:'disabled',nextStart:null};
    else if(!env.FOOTBALL_DB) throw new Error('live_configuration_missing');
    else result=await runTick(env,now,request);
  } catch(caught) {
    const code=String(caught?.message||'');
    const safe=/^[a-z_]{3,60}$/.test(code)?code:'live_acquisition_error';
    result={status:['quota_reserved','live_request_budget','live_write_budget','provider_minute_limit'].includes(safe)?safe:'error',nextStart:null};
    error=safe;
  }
  await env.LIVE_DB.prepare(`UPDATE live_control SET lease_until_ms=0,status=?,error_code=?,next_start_ms=?,
    last_success_ms=CASE WHEN ? IS NULL THEN ? ELSE last_success_ms END WHERE id=1 AND lease_owner=?`).bind(result.status,error||null,result.nextStart??null,error||null,now,owner).run();
  // Include the counter update itself; the 10k-row reserve also covers idle heartbeats.
  const day=new Date(now).toISOString().slice(0,10);
  await env.LIVE_DB.prepare('UPDATE live_budget SET rows_written=rows_written+? WHERE utc_day=?').bind(counter.rows+1,day).run();
  console.log(JSON.stringify({liveAcquisition:true,...result,error:error||null,at:new Date(now).toISOString()}));
  if(result.status==='error') throw new Error(error);
  return result;
}
export default { async scheduled(event,env){if(env.LIVE_ACQUISITION_MODE==='github')return dispatchLiveTick(event,env);return scheduledTick(event,env);}, fetch(){return new Response('Not found',{status:404});} };
