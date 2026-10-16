// Explicit one-off integration check against the real bucket. This never uses
// production dispatch keys and never calls GitHub or API-Football.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modulePath = process.env.JFW_WRANGLER_MODULE || 'wrangler';
const { getPlatformProxy } = require(modulePath);
assert.equal(JSON.parse(fs.readFileSync(require.resolve(`${modulePath}/package.json`))).version, '4.147.0');
assert.ok(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID, 'Cloudflare credentials required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-r2-remote-check-'));
const configPath = path.join(temp, 'wrangler.toml');
fs.writeFileSync(configPath, `name = "jfw-r2-remote-check"\ncompatibility_date = "2026-10-08"\n[[r2_buckets]]\nbinding = "STATE"\nbucket_name = "jfw-football-data"\nremote = true\n`);
const key = `automation/verification/r2-conditional/${randomUUID()}.json`;
let proxy, ownsKey = false;
try {
  proxy = await getPlatformProxy({ configPath, remoteBindings: true, persist: false, envFiles: [] });
  const bucket = proxy.env.STATE;
  assert.equal(await bucket.head(key), null, 'unique diagnostic key must be absent');
  // Mark this unique key for cleanup even when a put fails after delivery.
  ownsKey = true;
  const contenders = await Promise.allSettled(Array.from({ length: 16 }, (_, id) => bucket.put(key, JSON.stringify({ contender: id }), {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
  })));
  assert.equal(contenders.filter(result => result.status === 'rejected').length, 0, 'conditional rejection must resolve null');
  const winners = contenders.map((result, id) => ({ result: result.value, id })).filter(value => value.result !== null);
  assert.equal(winners.length, 1, 'exactly one real R2 conditional create must win');
  assert.deepEqual(await (await bucket.get(key)).json(), { contender: winners[0].id });
  // Independently read through Cloudflare's account API. A silently local
  // binding cannot satisfy this check, even if its conditional writes pass.
  const remote = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/jfw-football-data/objects/${key}`, {
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  assert.equal(remote.status, 200, 'diagnostic object must exist in the actual Cloudflare bucket');
  assert.deepEqual(await remote.json(), { contender: winners[0].id });
  const repeats = await Promise.all(Array.from({ length: 8 }, () => bucket.put(key, 'must-not-overwrite', { onlyIf: { etagDoesNotMatch: '*' } })));
  assert.ok(repeats.every(value => value === null), 'all later creates must lose');
  assert.deepEqual(await (await bucket.get(key)).json(), { contender: winners[0].id }, 'winner remains unchanged');
  console.log(JSON.stringify({ passed: true, remote: true, bucket: 'jfw-football-data', concurrentCreates: 16,
    successfulCreates: winners.length, rejectedConditions: 15, rejectedRepeatedCreates: 8, dispatchesSent: 0 }));
} finally {
  try {
    if (ownsKey) {
      await proxy.env.STATE.delete(key);
      assert.equal(await proxy.env.STATE.head(key), null, 'diagnostic key cleanup failed');
    }
  } finally {
    await proxy?.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
