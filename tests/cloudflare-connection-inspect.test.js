const test = require('node:test');
const assert = require('node:assert/strict');

const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-token-never-output' };
test('inspection makes only authenticated GET requests and excludes secret/unrelated binding values', async () => {
  const { inspectConnection } = await import('../scripts/v2/inspect-cloudflare-connection.mjs');
  const calls = [];
  const results = [
    [{ id: 'jfw-football-data-v2' }, { id: 'unrelated-service' }],
    { subdomain: 'ssdkllpd' },
    { bindings: [
      { name: 'API_FOOTBALL_KEY', type: 'secret_text', text: 'never-output-secret' },
      { name: 'UNRELATED', type: 'plain_text', text: 'never-output-unrelated' },
      { name: 'APP_ORIGINS', type: 'plain_text', text: 'https://ssdkllpd.github.io' },
      { name: 'FOOTBALL_DB', type: 'd1', id: 'never-output-db-id' },
    ] },
    { enabled: false },
  ];
  const report = await inspectConnection(env, async (url, init) => {
    calls.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    return Response.json({ success: true, result: results.shift() });
  });
  assert.deepEqual(calls.map(u => new URL(u).pathname.replace(`/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/`, '')), [
    'workers/scripts', 'workers/subdomain', 'workers/scripts/jfw-football-data-v2/settings', 'workers/scripts/jfw-football-data-v2/subdomain',
  ]);
  assert.equal(report.candidateOrigin, 'https://jfw-football-data-v2.ssdkllpd.workers.dev');
  assert.equal(report.workersDevEnabled, false);
  assert.equal(report.liveHttpVerified, false);
  assert.deepEqual(report.publicVars, { APP_ORIGINS: 'https://ssdkllpd.github.io' });
  assert.deepEqual(report.bindings, [{ name: 'FOOTBALL_DB', type: 'd1' }]);
  assert.doesNotMatch(JSON.stringify(report), /never-output|test-token|unrelated-service/);
});

test('authorization failures remain unknown and never echo API messages or fabricate a Worker URL', async () => {
  const { inspectConnection } = await import('../scripts/v2/inspect-cloudflare-connection.mjs');
  const report = await inspectConnection(env, async () => Response.json({
    success: false, errors: [{ code: 10000, message: env.CLOUDFLARE_API_TOKEN }],
  }, { status: 403 }));
  assert.equal(report.listed, null);
  assert.equal(report.candidateOrigin, null);
  assert.equal(report.workersDevEnabled, null);
  assert.ok(report.checks.every(c => !c.ok && c.httpStatus === 403));
  assert.doesNotMatch(JSON.stringify(report), /test-token/);
});

test('missing public Worker is reported without substituting the admin Worker', async () => {
  const { inspectConnection } = await import('../scripts/v2/inspect-cloudflare-connection.mjs');
  let calls = 0;
  const report = await inspectConnection(env, async () => Response.json({ success: true,
    result: ++calls === 1 ? [{ id: 'jfw-football-admin-ingest-staging' }] : { subdomain: 'ssdkllpd' },
  }));
  assert.equal(calls, 2);
  assert.equal(report.listed, false);
  assert.equal(report.workersDevEnabled, null);
  assert.equal(report.workerName, 'jfw-football-data-v2');
  assert.equal(report.liveHttpVerified, false);
});
