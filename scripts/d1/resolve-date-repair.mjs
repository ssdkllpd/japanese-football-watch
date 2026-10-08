import fs from 'node:fs';
import { adminScheduleSender } from './execute-fixture-schedule-plan.mjs';
import { drainDateRepairs } from './drain-date-repairs.mjs';

// The request file is an explicitly reviewed, date-bound authorization or enqueue.
const [requestFile]=process.argv.slice(2);
if(!requestFile || process.argv.length!==3) throw new Error('Use resolve-date-repair.mjs REVIEWED_REQUEST.json.');
const input=JSON.parse(fs.readFileSync(requestFile,'utf8'));
if(!['date_index_repair_authorize','date_index_repair_enqueue'].includes(input.operation)) throw new Error('A reviewed repair authorization or reconciliation request is required.');
const send=adminScheduleSender(process.env);
const authorization=await send(input);
const report=await drainDateRepairs(send,{dates:[input.date]});
console.log(JSON.stringify({authorization,...report}));
if(!report.passed) process.exitCode=1;
