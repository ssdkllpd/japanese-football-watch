import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync('config/cup-competitions.json','utf8'));
const target=JSON.parse(fs.readFileSync('config/public-worker-target.json','utf8'));
const expected=JSON.parse(fs.readFileSync('.tmp/cups/public/catalog.json','utf8'));
async function check(){
 const get=async path=>{const r=await fetch(target.workerOrigin+path,{headers:{origin:target.appOrigin,'cache-control':'no-cache'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Cup public verification HTTP ${r.status}`);return r.json();};
 const directory=await get('/api/v2/competitions');
 const reports=[];
 for(const entry of expected.competitions){
  if(!directory.competitions?.some(c=>c.id===entry.id))throw new Error(`Cup directory is not ready: ${entry.id}`);
  const prefix=`/api/v2/competitions/${encodeURIComponent(entry.id)}/seasons/${encodeURIComponent(entry.seasons[0].id)}`;
  const season=await get(prefix);
  if(season.competition?.id!==entry.id||season.fixtures?.length!==entry.seasons[0].summary.fixtureCount||season.cupSnapshot?.generatedAt!==expected.generatedAt)throw new Error(`Cup schedule mismatch ${entry.id}`);
  if(season.cupSnapshot.automaticUpdates!==config.acquisitionEnabled)throw new Error('Cup acquisition deployment is not ready');
  let standingsRows=0;
  if(season.cupSnapshot.standingsAvailable){const table=await get(prefix+'/standings');standingsRows=table.groups.reduce((n,g)=>n+g.table.length,0);if(!standingsRows)throw new Error('Cup standings are empty');}
  reports.push({id:entry.id,name:entry.name,fixtures:season.fixtures.length,publishedDetails:season.summary.publishedDetailCount,automaticUpdates:season.cupSnapshot.automaticUpdates,standingsRows});
 }
 console.log(JSON.stringify({passed:true,generatedAt:expected.generatedAt,competitions:reports}));
}
let failure;
for(let attempt=0;attempt<16;attempt++){
 try{await check();failure=null;break;}catch(error){failure=error;if(attempt<15)await new Promise(resolve=>setTimeout(resolve,20000));}
}
if(failure)throw failure;
