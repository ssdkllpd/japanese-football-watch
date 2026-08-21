'use strict';

const { createClientFromEnv, ApiFootballError } = require('./client');

async function main() {
  const client = createClientFromEnv();
  const { data, quota } = await client.get('/countries');

  console.log('API-Football connection: OK');
  console.log(`Countries returned: ${data.results ?? 'unknown'}`);
  console.log(`Daily requests remaining: ${quota.dailyRemaining ?? 'unknown'}`);
  console.log(`Per-minute requests remaining: ${quota.minuteRemaining ?? 'unknown'}`);
}

main().catch((error) => {
  if (error instanceof ApiFootballError) {
    console.error(`API-Football connection: FAILED - ${error.message}`);
    if (error.status !== null) console.error(`HTTP status: ${error.status}`);
    if (error.quota?.dailyRemaining !== null && error.quota?.dailyRemaining !== undefined) {
      console.error(`Daily requests remaining: ${error.quota.dailyRemaining}`);
    }
  } else {
    console.error(`API-Football connection: FAILED - ${error.message}`);
  }
  process.exitCode = 1;
});
