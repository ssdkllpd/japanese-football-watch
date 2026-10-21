import fs from 'node:fs';
const catalog=JSON.parse(fs.readFileSync('.tmp/cups/public/catalog.json','utf8'));
const url=new URL(process.env.ADMIN_INGEST_URL);
if(url.protocol!=='https:'||url.username||url.password||!process.env.ADMIN_INGEST_TOKEN)throw new Error('Cup catalog admin configuration missing');
url.pathname='/admin/v1/ingest';url.search='';url.hash='';
const reports=[];
for(const entry of catalog.competitions){
 const request={schemaVersion:'jfw-d1-admin-ingest/1',operation:'cup_catalog_publish',competitionId:entry.id,
  seasonId:entry.seasons[0].id,snapshotSha256:entry.snapshotSha256};
 const result=await fetch(url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${process.env.ADMIN_INGEST_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
 if(!result.ok)throw new Error(`Cup catalog initialization HTTP ${result.status}: ${entry.id}`);
 const body=await result.json();if(body.ok!==true||body.report?.competitionId!==entry.id)throw new Error('Cup catalog initialization response differs');
 reports.push(body.report);
}
console.log(JSON.stringify({cupCatalogInitialized:true,competitions:reports}));
