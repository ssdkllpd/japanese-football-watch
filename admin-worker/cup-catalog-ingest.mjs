import {readCupCatalog,loadCupSnapshot} from '../worker/cup-snapshots.mjs';
import {cupConfig} from '../shared/cup-snapshot-contract.mjs';
export const CUP_CATALOG_OPERATION='cup_catalog_publish';
export function assertCupCatalogRequest(value){
 const keys=['schemaVersion','operation','competitionId','seasonId','snapshotSha256'];
 if(!value||Object.keys(value).sort().join()!==keys.sort().join()||value.operation!==CUP_CATALOG_OPERATION
   ||!cupConfig(value.competitionId)||value.seasonId!==`af:season:${cupConfig(value.competitionId).providerId}:2026`
   ||!/^[a-f0-9]{64}$/.test(value.snapshotSha256||''))throw new Error('Cup catalog request scope is invalid');
 return value;
}
export async function publishCupCatalog(env,input){
 assertCupCatalogRequest(input);
 const catalog=await readCupCatalog(env),entry=catalog.find(c=>c.id===input.competitionId);
 if(!entry||entry.snapshotSha256!==input.snapshotSha256)throw new Error('Cup catalog source changed; retry with the current verified catalog');
 const value=await loadCupSnapshot(env,entry,input.seasonId);
 const db=env.FOOTBALL_DB;
 const first=async(sql,...params)=>(await db.prepare(sql).bind(...params).all()).results[0];
 const product=await first("SELECT id FROM product_seasons WHERE canonical_id='jfw:season:2026-27'");
 if(!product)throw new Error('Cup product season is not stored');
 const source=await first("SELECT id,api_version FROM provider_sources WHERE code='api-football'");
 if(!source||source.api_version!=='v3')throw new Error('Cup provider source is not stored');
 const c=value.competition,s=value.season;
 for(const date of [s.startsOn,s.endsOn])if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!Number.isFinite(Date.parse(date)))throw new Error('Cup season dates invalid');
 if(s.startsOn>s.endsOn)throw new Error('Cup season dates reversed');
 const prior=await first(`SELECT c.provider_id,c.source_id,c.type,s.canonical_id season_id,s.provider_season,
  s.starts_on,s.ends_on,c.name,c.country_name,c.logo_url,c.flag_url,s.status FROM competitions c
  LEFT JOIN competition_seasons s ON s.competition_id=c.id AND s.canonical_id=? WHERE c.canonical_id=?`,input.seasonId,c.id);
 if(prior&&(prior.provider_id!==c.providerId||prior.source_id!==source.id||prior.type!=='Cup'
  ||prior.season_id&&prior.provider_season!==2026))throw new Error('Stored cup identity differs');
 const same=prior?.season_id&&prior.starts_on===s.startsOn&&prior.ends_on===s.endsOn
  &&prior.name===c.name&&prior.country_name===c.country&&prior.logo_url===c.logo&&prior.flag_url===c.flag&&prior.status==='active';
 if(!same)await db.batch([
  db.prepare(`INSERT INTO competitions(canonical_id,source_id,provider_id,name,country_name,type,logo_url,flag_url)
   VALUES(?,?,?,?,?,'Cup',?,?) ON CONFLICT(canonical_id) DO UPDATE SET name=excluded.name,country_name=excluded.country_name,
    logo_url=excluded.logo_url,flag_url=excluded.flag_url`).bind(c.id,source.id,c.providerId,c.name,c.country,c.logo,c.flag),
  db.prepare(`INSERT INTO competition_seasons(canonical_id,competition_id,product_season_id,provider_season,label,starts_on,ends_on,status)
   VALUES(?,(SELECT id FROM competitions WHERE canonical_id=?),?,2026,?,?,?,'active')
   ON CONFLICT(canonical_id) DO UPDATE SET starts_on=excluded.starts_on,ends_on=excluded.ends_on,status='active'`)
   .bind(s.id,c.id,product.id,s.label,s.startsOn,s.endsOn),
 ]);
 return {operation:CUP_CATALOG_OPERATION,competitionId:c.id,seasonId:s.id,imported:!same,snapshotSha256:input.snapshotSha256};
}
