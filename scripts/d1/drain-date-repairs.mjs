const VERSION='jfw-d1-admin-ingest/1';

// One failed date is attempted once per run; healthy dates continue and failures stay visible.
export async function drainDateRepairs(send, scope = {}, maxCalls = 100) {
  const failures=[],repairedDates=[],attempted=new Set();
  let calls=0;
  while(calls<maxCalls) {
    const inventory=await send({schemaVersion:VERSION,operation:'fixture_schedule_repair_status',...scope,excludeDates:[...attempted]});
    if(!Array.isArray(inventory.dates) || !Number.isSafeInteger(inventory.remaining)) throw new Error('Repair inventory response is invalid.');
    if(inventory.remaining===0) break;
    const next=inventory.dates.find(row=>!attempted.has(row.date_jst));
    if(!next) throw new Error('Repair inventory returned no candidate for its remaining count.');
    attempted.add(next.date_jst);calls++;
    try {
      await send({schemaVersion:VERSION,operation:'fixture_schedule_repair',date:next.date_jst});
      repairedDates.push(next.date_jst);
    } catch(error) {
      failures.push({date:next.date_jst,detail:String(error.message)});
    }
  }
  const ending=await send({schemaVersion:VERSION,operation:'fixture_schedule_repair_status',...scope});
  return {passed:failures.length===0 && ending.remaining===0,repairedDates,failures,remaining:ending.remaining,
    ...(ending.remaining ? {bounded:true} : {})};
}
