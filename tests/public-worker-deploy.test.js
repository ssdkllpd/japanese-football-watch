'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'config', 'public-worker-target.json');

test('public Worker target and rendered configuration lock the reviewed origins and resources', async t => {
  const { loadPublicWorkerTarget, renderPublicWrangler } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = loadPublicWorkerTarget(manifestPath);
  assert.equal(target.workerName, 'jfw-football-data-v2');
  assert.equal(target.workerOrigin, 'https://jfw-football-data-v2.ssdkllpd.workers.dev');
  assert.equal(target.appOrigin, 'https://ssdkllpd.github.io');
  assert.equal(target.r2BucketName, 'jfw-football-data');
  assert.equal(target.d1DatabaseId, 'fdfd74e4-2702-4aa2-ab20-c062e952fe25');
  assert.equal(target.d1CutoverAuthorization.migrationWorkflowRunId, 35090817724);
  assert.equal(
    target.d1CutoverAuthorization.migrationCommit,
    '8ce12d98017286ed18682583fea71951525724ef',
  );
  assert.equal(
    target.d1CutoverAuthorization.migrationTree,
    '2e5b35e746f9babedf402ec628bf25f4df8d26f0',
  );
  assert.equal(
    target.d1CutoverAuthorization.migrationArtifactSha256,
    'f0e16d1c741c7d47e22b989ec5b5e40afba570d71cb57c9b848b5faa7401e68a',
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-public-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rendered = renderPublicWrangler(target, path.join(directory, 'wrangler.toml'));
  assert.match(rendered, /name = "jfw-football-data-v2"/);
  assert.match(rendered, /workers_dev = true/);
  assert.match(rendered, /binding = "FOOTBALL_DATA"/);
  assert.match(rendered, /binding = "FOOTBALL_DB"/);
  assert.match(rendered, /APP_ORIGINS = "https:\/\/ssdkllpd.github.io"/);
  assert.match(rendered, /LIVE_COMPETITION_IDS = "39,40,61,78,88,94,135,140,144,179"/);
  for (const flag of Object.keys(target.d1ReadFlags)) {
    assert.match(rendered, new RegExp(`${flag} = "true"`));
  }
  const rollback = renderPublicWrangler(target, path.join(directory, 'rollback.toml'), {
    disableD1Reads: true,
  });
  for (const flag of Object.keys(target.d1ReadFlags)) {
    assert.match(rollback, new RegExp(`${flag} = "false"`));
  }
  assert.equal(rendered.includes('API_FOOTBALL_KEY'), false);
});

test('committed Web UI configuration points at the reviewed public Worker origin', async () => {
  const vm = require('node:vm');
  const { loadPublicWorkerTarget } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = loadPublicWorkerTarget(manifestPath);
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app-v2-config.js'), 'utf8'), context);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.apiBase, target.workerOrigin);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.trackingEnabled, false);
  assert.equal(context.window.FOOTBALL_V2_CONFIG.attentionEnabled, false);
});

test('public Worker renderer rejects target drift and unreviewed D1 read flags', async () => {
  const { loadPublicWorkerTarget } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-public-target-'));
  try {
    const drifted = path.join(directory, 'drifted.json');
    fs.writeFileSync(drifted, JSON.stringify({ ...target, workerOrigin: 'https://other.workers.dev' }));
    assert.throws(() => loadPublicWorkerTarget(drifted), /workerOrigin does not match/);
    const unauthorized = path.join(directory, 'unauthorized.json');
    fs.writeFileSync(unauthorized, JSON.stringify({
      ...target,
      d1CutoverAuthorization: {
        ...target.d1CutoverAuthorization,
        authorizedFlags: target.d1CutoverAuthorization.authorizedFlags
          .filter(name => name !== 'D1_STANDINGS_ENABLED'),
      },
    }));
    assert.throws(() => loadPublicWorkerTarget(unauthorized), /not authorized.*D1_STANDINGS_ENABLED/);

    const wrongDatabase = path.join(directory, 'wrong-database.json');
    fs.writeFileSync(wrongDatabase, JSON.stringify({
      ...target,
      d1CutoverAuthorization: {
        ...target.d1CutoverAuthorization,
        databaseId: '00000000-0000-0000-0000-000000000000',
      },
    }));
    assert.throws(() => loadPublicWorkerTarget(wrongDatabase), /databaseId does not match/);

    const { d1CutoverAuthorization, d1ReadProbes, ...withoutAuthorization } = target;
    const disabled = path.join(directory, 'disabled.json');
    fs.writeFileSync(disabled, JSON.stringify({
      ...withoutAuthorization,
      d1ReadFlags: Object.fromEntries(Object.keys(target.d1ReadFlags).map(name => [name, false])),
    }));
    assert.doesNotThrow(() => loadPublicWorkerTarget(disabled));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment verifies every D1 route and automatically rolls back failed cutover checks', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'public-worker-deploy.yml'), 'utf8',
  );
  assert.match(workflow, /push:[\s\S]*branches: \[main\]/);
  assert.match(workflow, /scripts\/d1\/fixture-repository\.js/);
  assert.match(workflow, /environment: d1-staging/);
  const render = workflow.indexOf('render-public-wrangler.mjs');
  const deploy = workflow.indexOf('wrangler@4 deploy');
  const secret = workflow.indexOf('secret put API_FOOTBALL_KEY');
  const health = workflow.indexOf('Verify allowed-origin health and CORS');
  const d1Reads = workflow.indexOf('Verify every enabled D1 public read path');
  const rollback = workflow.indexOf('Roll back all D1 public reads');
  assert.equal(
    render > 0 && deploy > render && secret > deploy && health > secret
      && d1Reads > health && rollback > d1Reads,
    true,
  );
  assert.match(workflow, /access-control-allow-origin/);
  assert.match(workflow, /x-jfw-data-source: d1/);
  assert.match(workflow, /api\/v2\/dates/);
  assert.match(workflow, /api\/v2\/competitions/);
  assert.match(workflow, /api\/v2\/fixtures/);
  assert.match(workflow, /--disable-d1-reads/);
  assert.match(workflow, /failure\(\).*steps\.deploy\.outcome == 'success'/);
  assert.match(workflow, /--retry-all-errors/);
  assert.match(workflow, /test "\$status" = '403'/);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('d1 migrations apply'), false);
});
