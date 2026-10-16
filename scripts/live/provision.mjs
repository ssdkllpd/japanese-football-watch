import fs from 'node:fs';
import { loadLiveTarget,renderLiveTarget,ROOT } from './target.mjs';
const target=loadLiveTarget();
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!/^[a-f0-9]{32}$/i.test(account||'')||!token) throw new Error('Live provisioning credentials missing');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;
async function api(url,options={}) {
  const response=await fetch(url,{...options,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok) throw new Error(`Live provisioning HTTP ${response.status}`);
  const body=await response.json();if(body.success!==true || (Array.isArray(body.result)&&body.result.some(row=>row.success===false))) throw new Error('Live provisioning API failed');return body.result;
}
let found;
for(let page=1;page<=10;page++) {
  const databases=await api(`${base}?page=${page}&per_page=100`);
  if(!Array.isArray(databases)) throw new Error('Invalid database inventory');
  const matches=databases.filter(value=>value.name===target.databaseName);
  if(matches.length>1) throw new Error('Ambiguous live database');
  if(matches.length){found=matches[0];break;}
  if(databases.length<100) break;
  if(page===10) throw new Error('Database inventory truncated');
}
if(!found) {
  if(target.databaseId) throw new Error('Reviewed live database is missing');
  found=await api(base,{method:'POST',body:JSON.stringify({name:target.databaseName,primary_location_hint:'apac'})});
}
if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(found.uuid||'')) throw new Error('Invalid created database ID');
if(target.databaseId&&target.databaseId!==found.uuid) throw new Error('Live database ID drift');
const core=JSON.parse(fs.readFileSync(`${ROOT}/config/public-worker-target.json`));
if(found.uuid===core.d1DatabaseId) throw new Error('Live and core databases must be separate');
const sql=fs.readdirSync(`${ROOT}/migrations/live`).filter(name=>/^\d{4}_[a-z_]+\.sql$/.test(name)).sort().map(name=>fs.readFileSync(`${ROOT}/migrations/live/${name}`,'utf8')).join('\n');
await api(`${base}/${found.uuid}/query`,{method:'POST',body:JSON.stringify({sql})});
const check=await api(`${base}/${found.uuid}/query`,{method:'POST',body:JSON.stringify({sql:'SELECT version FROM live_schema WHERE id=1'})});
if(check?.[0]?.results?.[0]?.version!==1) throw new Error('Live schema verification failed');
const resolved={...target,databaseId:found.uuid};
renderLiveTarget(resolved,'.tmp/live/wrangler.toml');
fs.writeFileSync('.tmp/live/target.json',`${JSON.stringify(resolved,null,2)}\n`);
console.log(JSON.stringify({liveDatabase:found.uuid,name:target.databaseName,enabled:target.acquisitionEnabled,coreDatabaseUnchanged:true}));
