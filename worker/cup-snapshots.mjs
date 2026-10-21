import {CUP_CATALOG_KEY,cupConfig,cupSnapshotKey,assertCupSnapshot,cupDirectoryEntry} from '../shared/cup-snapshot-contract.mjs';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8',
  'cache-control':status===200?'public, max-age=300':'no-store','x-jfw-data-source':'r2-cup-snapshot'}});
export async function readCupCatalog(env) {
  if(!env.FOOTBALL_DATA?.get)return [];
  const object=await env.FOOTBALL_DATA.get(CUP_CATALOG_KEY);if(!object)return [];
  const catalog=JSON.parse(await object.text());
  if(catalog.schemaVersion!=='jfw-cup-catalog/1'||!Array.isArray(catalog.competitions)||catalog.competitions.length>20)throw new Error('Cup catalog invalid');
  const ids=new Set();
  for(const c of catalog.competitions){
    if(!cupConfig(c.id)||ids.has(c.id)||!Array.isArray(c.seasons)||c.seasons.length!==1
      ||c.seasons[0].id!==`af:season:${cupConfig(c.id).providerId}:2026`
      ||!/^[a-f0-9]{64}$/.test(c.snapshotSha256)||c.snapshotKey!==cupSnapshotKey(c.snapshotSha256))throw new Error('Cup catalog identity invalid');
    ids.add(c.id);
  }
  return catalog.competitions;
}
export async function loadCupSnapshot(env,entry,seasonId){
    const object=await env.FOOTBALL_DATA.get(entry.snapshotKey);
    if(!object)throw new Error('Cup snapshot missing');
    const raw=await object.text();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
    if(digest!==entry.snapshotSha256)throw new Error('Cup snapshot hash mismatch');
    return assertCupSnapshot(JSON.parse(raw),entry.id,seasonId);
}
export async function cupResponse(env,id,{seasonId,date,standings=false}={}) {
  try{
    const entry=(await readCupCatalog(env)).find(c=>c.id===id);
    if(!entry)return json({error:'Cup snapshot has not been acquired'},404);
    const expected=entry.seasons[0].id;
    if(seasonId&&seasonId!==expected)return json({error:'Cup season not acquired',availableSeasons:[expected]},404);
    const value=await loadCupSnapshot(env,entry,expected);
    if(standings)return value.standings?json(value.standings):json({error:'This cup has no league table',code:'not_applicable'},404);
    if(date){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00.000Z'))||new Date(date+'T00:00:00.000Z').toISOString().slice(0,10)!==date)return json({error:'Invalid date'},400);
      return json({contractVersion:'2.0.0',timeZone:'Asia/Tokyo',date,competition:value.competition,
        fixtures:value.fixtures.filter(f=>f.dateJst===date).map(({round,...f})=>f),generatedAt:value.generatedAt});
    }
    const summary=cupDirectoryEntry(value).seasons[0].summary;
    return json({contractVersion:'2.0.0',competition:value.competition,season:value.season,summary,
      fixtures:value.fixtures,cupSnapshot:{generatedAt:value.generatedAt,automaticUpdates:false,standingsAvailable:value.standings!==null},
      playerStats:{presence:'not_fetched',rows:[]},detailSections:{}});
  }catch{return json({error:'Cup snapshot is unavailable'},503);}
}
