import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import config from '../../config/cup-competitions.json' with {type:'json'};
import fixturesModule from '../v2/fixture-contract.js';
import standingsModule from '../v2/fetch-standings.js';
import {assertCupSnapshot,cupDirectoryEntry,cupSnapshotKey,CUP_CATALOG_KEY} from '../../shared/cup-snapshot-contract.mjs';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
export function prepareCups(raw,{source=config.source}={}) {
  if(hash(raw)!==source.snapshotSha256)throw new Error('Cup source hash mismatch');
  const snapshot=JSON.parse(raw),objects=[];
  if(snapshot.schemaVersion!=='jfw-cup-inspection/1'||snapshot.season!==config.providerSeason)throw new Error('Cup source schema is invalid');
  for(const target of config.competitions){
    const cup=snapshot.cups.find(c=>c.metadata?.league?.id===target.providerId);
    if(!cup||cup.status!=='available'||cup.country!==target.country||cup.metadata.league.name!==target.label)throw new Error(`Cup source identity differs: ${target.id}`);
    const first=fixturesModule.normalizeFixtureBundle(cup.fixtures[0],{fetchedAt:snapshot.observedAt});
    const season={...first.season,startsOn:cup.season.start,endsOn:cup.season.end,status:cup.season.current?'active':'unknown'};
    const value={schemaVersion:'jfw-cup-public-snapshot/1',competition:first.competition,season,
      generatedAt:snapshot.observedAt,fixtures:cup.fixtures.map(raw=>{
        const bundle=fixturesModule.normalizeFixtureBundle(raw,{fetchedAt:snapshot.observedAt});
        return {...fixturesModule.fixtureIndexEntry(bundle),round:bundle.fixture.round};
      }).sort((a,b)=>a.kickoffUtc.localeCompare(b.kickoffUtc)||a.fixtureId.localeCompare(b.fixtureId)),
      standings:cup.standings?.length?standingsModule.normalizeStandings(cup.standings,{league:target.providerId,season:config.providerSeason,fetchedAt:snapshot.observedAt,teams:cup.standingsTeams||cup.fixtures.flatMap(f=>[f.teams.home,f.teams.away])}):null};
    assertCupSnapshot(value,target.id,season.id);
    const text=JSON.stringify(value),sha256=hash(text);
    objects.push({key:cupSnapshotKey(sha256),sha256,text,entry:cupDirectoryEntry(value)});
  }
  const catalog={schemaVersion:'jfw-cup-catalog/1',generatedAt:snapshot.observedAt,sourceSha256:source.snapshotSha256,
    competitions:objects.map(o=>({...o.entry,snapshotKey:o.key,snapshotSha256:o.sha256}))};
  return {objects,catalog,catalogKey:CUP_CATALOG_KEY};
}
export function writePreparedCups(prepared,dir='.tmp/cups/public') {
  fs.mkdirSync(dir,{recursive:true});
  for(const object of prepared.objects)fs.writeFileSync(`${dir}/${object.sha256}.json`,object.text);
  fs.writeFileSync(`${dir}/catalog.json`,JSON.stringify(prepared.catalog));
  fs.writeFileSync(`${dir}/uploads.json`,JSON.stringify(prepared.objects.map(o=>({key:o.key,file:`${dir}/${o.sha256}.json`,sha256:o.sha256}))));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const prepared=prepareCups(fs.readFileSync(process.argv[2]||'.tmp/cups/snapshot.json','utf8'));
  writePreparedCups(prepared);
  console.log(JSON.stringify({cups:prepared.objects.length,fixtures:prepared.catalog.competitions.reduce((n,c)=>n+c.seasons[0].summary.fixtureCount,0),generatedAt:prepared.catalog.generatedAt}));
}
