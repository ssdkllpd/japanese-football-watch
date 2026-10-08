import { dateIndexR2Key } from '../shared/date-index-contract.mjs';

export const REPAIR_STATUS_OPERATION = 'fixture_schedule_repair_status';
export const REPAIR_AUTHORIZE_OPERATION = 'date_index_repair_authorize';
export const REPAIR_ENQUEUE_OPERATION = 'date_index_repair_enqueue';
export function realRepairDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
export function assertRepairControlRequest(input) {
  const allowed = input.operation === REPAIR_STATUS_OPERATION
    ? ['schemaVersion','operation','dates','fixtureId','excludeDates']
    : input.operation === REPAIR_AUTHORIZE_OPERATION
      ? ['schemaVersion','operation','date','expectedRepairToken','sourceSha256','orphanFixtureIds','allowInvalidPrevious','reason']
      : ['schemaVersion','operation','date','reason'];
  if (Object.keys(input).some(key=>!allowed.includes(key))) throw new Error('Unknown repair control fields.');
  if (input.operation === REPAIR_STATUS_OPERATION) {
    if (input.dates !== undefined && (!Array.isArray(input.dates) || input.dates.length > 6
      || input.dates.some(date=>!realRepairDate(date)) || new Set(input.dates).size!==input.dates.length)) throw new Error('Invalid repair date scope.');
    if(input.excludeDates!==undefined && (!Array.isArray(input.excludeDates) || input.excludeDates.length>100 || input.excludeDates.some(date=>!realRepairDate(date)))) throw new Error('Invalid excluded repair dates.');
    if (input.fixtureId !== undefined && !/^af:fixture:\d+$/.test(input.fixtureId)) throw new Error('Invalid repair fixture scope.');
  } else {
    if (!realRepairDate(input.date) || typeof input.reason !== 'string'
      || input.reason.trim().length < 10 || input.reason.length > 1000) throw new Error('Repair requires a date and investigation reason.');
    if (input.operation === REPAIR_AUTHORIZE_OPERATION && (!/^[a-f0-9]{64}$/.test(input.sourceSha256)
      || typeof input.expectedRepairToken !== 'string' || !input.expectedRepairToken
      || typeof input.allowInvalidPrevious !== 'boolean' || !Array.isArray(input.orphanFixtureIds)
      || input.orphanFixtureIds.length > 100 || input.orphanFixtureIds.some(id=>!/^af:fixture:\d+$/.test(id))
      || new Set(input.orphanFixtureIds).size!==input.orphanFixtureIds.length)) throw new Error('Repair authorization evidence is invalid.');
  }
  return input;
}

export async function readRepairStatus(env, input = {}) {
  const db=env.FOOTBALL_DB;
  const selected=new Set(input.dates || []);
  if (input.fixtureId) {
    const rows=await db.prepare(`SELECT f.date_jst,p.old_date_jst,p.new_date_jst,p.registered_dates_json
      FROM fixtures f LEFT JOIN fixture_schedule_refresh_pending p ON p.fixture_id=f.canonical_id
      WHERE f.canonical_id=?`).bind(input.fixtureId).all();
    const historical=await db.prepare('SELECT date_jst FROM date_index_repair_fixture_dates WHERE fixture_id=?').bind(input.fixtureId).all();
    for(const row of historical.results) selected.add(row.date_jst);
    for (const row of rows.results) for (const date of [row.date_jst,row.old_date_jst,row.new_date_jst,...JSON.parse(row.registered_dates_json || '[]')]) if(date) selected.add(date);
  }
  const scoped=input.fixtureId!==undefined || input.dates!==undefined;
  const results=await db.prepare(`WITH dates AS (
      SELECT date_jst FROM date_index_repair_queue
      UNION SELECT j.value FROM fixture_schedule_refresh_pending p JOIN fixtures f ON f.canonical_id=p.fixture_id,
        json_each(json_array(p.old_date_jst,p.new_date_jst,f.date_jst)) j
        WHERE j.value NOT IN (SELECT value FROM json_each(p.registered_dates_json))
      UNION SELECT f.date_jst FROM fixture_schedule_refresh_pending p JOIN fixtures f ON f.canonical_id=p.fixture_id
        WHERE NOT EXISTS (SELECT 1 FROM date_index_repair_queue q WHERE q.date_jst IN
          (SELECT value FROM json_each(p.registered_dates_json)) OR q.date_jst IN (p.old_date_jst,p.new_date_jst,f.date_jst))
    ) SELECT dates.date_jst,q.repair_token,
      (SELECT detail FROM date_index_repair_failures e WHERE e.date_jst=dates.date_jst ORDER BY id DESC LIMIT 1) AS last_error,
      COUNT(*) OVER () AS total FROM dates LEFT JOIN date_index_repair_queue q ON q.date_jst=dates.date_jst
      WHERE (?=0 OR dates.date_jst IN (SELECT value FROM json_each(?)))
        AND dates.date_jst NOT IN (SELECT value FROM json_each(?)) ORDER BY dates.date_jst LIMIT 100`)
    .bind(scoped?1:0,JSON.stringify([...selected]),JSON.stringify(input.excludeDates || [])).all();
  if(results.success===false) throw new Error('Repair inventory query failed.');
  return {operation:REPAIR_STATUS_OPERATION,dates:results.results.map(({total,...row})=>row),
    remaining:results.results[0]?.total || 0};
}

export async function recordRepairFailure(env,date,error) {
  await env.FOOTBALL_DB.prepare(`INSERT INTO date_index_repair_failures(date_jst,repair_token,attempted_at,detail)
    VALUES(?,(SELECT repair_token FROM date_index_repair_queue WHERE date_jst=?),?,?)`)
    .bind(date,date,new Date().toISOString(),String(error.message).slice(0,2000)).run();
}

export async function enqueueDateRepair(env,input) {
  const now=new Date().toISOString(), token=crypto.randomUUID();
  await env.FOOTBALL_DB.batch([
    env.FOOTBALL_DB.prepare(`INSERT INTO date_index_repair_queue(date_jst,repair_token,changed_at) VALUES(?,?,?)
      ON CONFLICT(date_jst) DO UPDATE SET repair_token=excluded.repair_token,changed_at=excluded.changed_at`).bind(input.date,token,now),
    env.FOOTBALL_DB.prepare(`INSERT INTO date_index_repair_failures(date_jst,repair_token,attempted_at,detail) VALUES(?,?,?,?)`)
      .bind(input.date,token,now,`Investigation/reconciliation requested: ${input.reason}`),
  ]);
  return {operation:REPAIR_ENQUEUE_OPERATION,date:input.date,repairToken:token};
}

export async function sha256Text(raw) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// This grants a narrowly bound rebuild; it never erases the queue or fabricates D1 data.
export async function authorizeDateRepair(env,input) {
  const db=env.FOOTBALL_DB;
  const queue=await db.prepare('SELECT repair_token FROM date_index_repair_queue WHERE date_jst=?').bind(input.date).first();
  if(queue?.repair_token!==input.expectedRepairToken) throw new Error('Repair authorization token is stale.');
  const object=await env.FOOTBALL_DATA.get(dateIndexR2Key(input.date));
  if(!object) throw new Error('Repair authorization requires existing R2 evidence.');
  const raw=await object.text();
  if(await sha256Text(raw)!==input.sourceSha256) throw new Error('Repair authorization R2 evidence changed.');
  const known=await db.prepare('SELECT canonical_id FROM fixtures WHERE canonical_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(input.orphanFixtureIds)).all();
  if(known.results.length) throw new Error('A declared orphan still exists in D1.');
  let previous;
  try {previous=JSON.parse(raw);} catch {if(!input.allowInvalidPrevious) throw new Error('Malformed R2 requires explicit approval.');}
  if(input.orphanFixtureIds.length && (!Array.isArray(previous?.fixtures)
    || input.orphanFixtureIds.some(id=>!previous.fixtures.some(item=>item.fixtureId===id)))) throw new Error('Orphan identity is absent from the evidence.');
  const key=`audit/date-repair/${input.date}/${input.sourceSha256}.json`;
  await env.FOOTBALL_DATA.put(key,raw,{httpMetadata:{contentType:'application/json'}});
  const written=await db.prepare(`INSERT INTO date_index_repair_authorizations
      (date_jst,source_sha256,orphan_ids_json,allow_invalid,reason,evidence_key,approved_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM date_index_repair_queue WHERE date_jst=? AND repair_token=?)
      ON CONFLICT(date_jst,source_sha256) DO UPDATE SET orphan_ids_json=excluded.orphan_ids_json,
        allow_invalid=excluded.allow_invalid,reason=excluded.reason,evidence_key=excluded.evidence_key,approved_at=excluded.approved_at`)
    .bind(input.date,input.sourceSha256,JSON.stringify(input.orphanFixtureIds),input.allowInvalidPrevious?1:0,input.reason,key,new Date().toISOString(),input.date,input.expectedRepairToken).run();
  if(written.success===false || written.meta?.changes!==1) throw new Error('Repair authorization token changed.');
  return {operation:REPAIR_AUTHORIZE_OPERATION,date:input.date,sourceSha256:input.sourceSha256,evidenceKey:key};
}
