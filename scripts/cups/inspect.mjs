import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import clientModule from '../api-football/client.js';
import standingsModule from '../v2/fetch-standings.js';
import {remoteDatabase} from '../live/remote-d1.mjs';

const TARGETS = [
  ['World','UEFA Champions League'], ['World','UEFA Europa League'],
  ['World','UEFA Europa Conference League'], ['England','League Cup'], ['England','FA Cup'],
  ['Germany','DFB Pokal'], ['France','Coupe de France'], ['Netherlands','KNVB Beker'],
  ['Belgium','Cup'], ['Spain','Copa del Rey'], ['Italy','Coppa Italia'],
  ['Portugal','Taça de Portugal'], ['Portugal','Taça da Liga'],
  ['Scotland','FA Cup'], ['Scotland','League Cup'],
];
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function responseRows(result,label) {
  const rows=result.data?.response;
  if(!Array.isArray(rows)||Number(result.data?.paging?.total??1)!==1
    ||Number(result.data?.results??rows.length)!==rows.length)throw new Error(`${label} response is incomplete`);
  return rows;
}
export async function inspectCups({client,database,season=2026,now=new Date().toISOString()}) {
  const quota=await client.refreshDailyQuota();
  if(!Number.isSafeInteger(quota.dailyRemaining)||quota.dailyRemaining<1250)throw new Error('Cup inspection must preserve 1200 provider requests');
  const stored=(await database.prepare(`SELECT c.canonical_id competitionId,c.name,c.country_name country,s.canonical_id seasonId,
    COUNT(f.id) fixtures,COUNT(f.published_revision) publishedDetails
    FROM competitions c JOIN competition_seasons s ON s.competition_id=c.id
    LEFT JOIN fixtures f ON f.competition_season_id=s.id
    GROUP BY c.id,s.id ORDER BY c.canonical_id,s.canonical_id`).all()).results;
  const leagues=responseRows(await client.get('leagues',{type:'Cup',season}),'Cup metadata');
  const cups=[];
  for(const [country,name] of TARGETS) {
    const matches=leagues.filter(item=>item.country?.name===country&&normalize(item.league?.name)===normalize(name));
    if(matches.length>1)throw new Error(`Ambiguous cup metadata: ${country}/${name}`);
    const meta=matches[0], providerSeason=meta?.seasons?.find(item=>item.year===season);
    if(!meta||!providerSeason){cups.push({country,requestedName:name,status:'season_not_available'});continue;}
    const id=meta.league?.id;
    if(!Number.isSafeInteger(id)||id<=0||meta.league.type!=='Cup')throw new Error('Invalid cup identity');
    const fixtures=responseRows(await client.get('fixtures',{league:id,season,timezone:'Asia/Tokyo'}),`${name} fixtures`);
    const ids=new Set();
    for(const fixture of fixtures){
      if(!Number.isSafeInteger(fixture.fixture?.id)||fixture.fixture.id<=0||ids.has(fixture.fixture.id)
        ||fixture.league?.id!==id||fixture.league?.season!==season)throw new Error(`Invalid ${name} fixture identity`);
      ids.add(fixture.fixture.id);
    }
    const standings=providerSeason.coverage?.standings===true
      ?responseRows(await client.get('standings',{league:id,season}),`${name} standings`):null;
    const standingsTeams=standings ? await standingsModule.fetchStandingsTeams(client,standings,{league:id,season}) : [];
    cups.push({country,requestedName:name,status:fixtures.length?'available':'fixtures_not_yet_available',
      metadata:meta,season:providerSeason,fixtures,standings,standingsTeams});
  }
  return {schemaVersion:'jfw-cup-inspection/1',observedAt:now,season,stored,cups,quota:client.lastQuota};
}
export function summarize(snapshot) {
  return {schemaVersion:snapshot.schemaVersion,observedAt:snapshot.observedAt,season:snapshot.season,
    stored:snapshot.stored,cups:snapshot.cups.map(c=>({country:c.country,name:c.metadata?.league?.name||c.requestedName,
      id:c.metadata?.league?.id??null,status:c.status,fixtures:c.fixtures?.length??null,
      teams:c.fixtures?new Set(c.fixtures.flatMap(f=>[f.teams?.home?.id,f.teams?.away?.id]).filter(Boolean)).size:null,
      standingsGroups:c.standings?.flatMap(r=>r.league?.standings||[]).length??null,
      standingsIdentityCandidates:(c.standingsTeams||[]).filter(team=>(c.standings||[])
        .flatMap(r=>r.league?.standings||[]).flat().some(row=>row?.team?.id==null
          &&row.team.name?.normalize('NFKC').toLowerCase()===team.name?.normalize('NFKC').toLowerCase())),
      invalidStandingsRows:(c.standings||[]).flatMap(r=>r.league?.standings||[]).flat()
        .filter(row=>!Number.isSafeInteger(row?.team?.id)||row.team.id<=0),
      coverage:c.season?.coverage??null,start:c.season?.start??null,end:c.season?.end??null})),quota:snapshot.quota};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const target=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
  const client=clientModule.createClientFromEnv(process.env,{minimumIntervalMs:350,dailyReserve:1200});
  const database=remoteDatabase({account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,
    databaseId:target.d1DatabaseId,readOnly:true});
  const snapshot=await inspectCups({client,database});
  const raw=JSON.stringify(snapshot),sha256=createHash('sha256').update(raw).digest('hex');
  const key=`audit/cup-competitions/${snapshot.observedAt.replace(/[:.]/g,'-')}/${sha256}.json`;
  const summary={...summarize(snapshot),snapshotKey:key,snapshotSha256:sha256};
  fs.mkdirSync('.tmp/cups',{recursive:true});fs.writeFileSync('.tmp/cups/snapshot.json',raw);
  fs.writeFileSync('.tmp/cups/summary.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
}
