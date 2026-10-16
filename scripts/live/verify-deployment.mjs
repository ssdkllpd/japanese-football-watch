import fs from 'node:fs';
const target=JSON.parse(fs.readFileSync('.tmp/live/target.json'));
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
const started=Date.now();
async function query(sql) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${target.databaseId}/query`,{
    method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({sql}),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Live verification HTTP ${response.status}`);
  const body=await response.json();if(body.success!==true||body.result?.[0]?.success!==true) throw new Error('Live verification query failed');return body.result[0].results;
}
while(Date.now()-started<18*60000) {
  const row=(await query('SELECT heartbeat_ms,last_success_ms,enabled,status,error_code,daily_day,next_start_ms FROM live_control WHERE id=1'))[0];
  if(row?.heartbeat_ms>=started-1000&&row.enabled===(target.acquisitionEnabled?1:0)) {
    if(row.status==='error') throw new Error(`Live cron failed: ${row.error_code}`);
    if(!target.acquisitionEnabled||row.last_success_ms>=started-1000) {
      const budget=await query('SELECT utc_day,requests,remaining,rows_written FROM live_budget ORDER BY utc_day DESC LIMIT 1');
      const upcoming=await query(`SELECT fixture_id,status,kickoff_ms,check_2h_ms,check_1h_ms FROM live_schedule WHERE kickoff_ms>=${Date.now()} ORDER BY kickoff_ms LIMIT 5`);
      const report={passed:true,databaseId:target.databaseId,enabled:target.acquisitionEnabled,control:row,budget,upcoming,verifiedAt:new Date().toISOString()};
      fs.writeFileSync('.tmp/live/verification.json',`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report));process.exit(0);
    }
  }
  console.log(JSON.stringify({waitingForLiveCron:true,status:row?.status??null,elapsedSeconds:Math.floor((Date.now()-started)/1000)}));
  await new Promise(resolve=>setTimeout(resolve,10000));
}
throw new Error('Live cron heartbeat verification timed out');
