export function remoteDatabase({account,token,databaseId,request=fetch,readOnly=false}) {
 if(!/^[a-f0-9]{32}$/i.test(account||'')||!token||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId||''))throw new Error('Remote live database configuration invalid');
 const native=new WeakMap();
 async function execute(statements,batch) {
  if(readOnly&&statements.some(stmt=>!/^\s*SELECT\b/i.test(stmt.sql)))throw new Error('Core live access must be read only');
  const response=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`,{
   method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(batch?{batch:statements}:statements[0]),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Live database HTTP ${response.status}`);
  const body=await response.json();if(body.success!==true||!Array.isArray(body.result)||body.result.length!==statements.length||body.result.some(result=>result.success!==true||!Array.isArray(result.results)))throw new Error('Remote live database response invalid');
  return batch?body.result:body.result[0];
 }
 const prepare=(sql,params=[])=>{
  const value={sql,params},stmt={bind:(...values)=>prepare(sql,values),all:()=>execute([value],false),run:()=>execute([value],false)};
  native.set(stmt,value);return stmt;
 };
 return {prepare,batch:statements=>execute(statements.map(stmt=>{const value=native.get(stmt);if(!value)throw new Error('Foreign live statement');return value;}),true)};
}
