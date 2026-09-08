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
    assert.match(rendered, new RegExp(`${flag} = "false"`));
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

test('public Worker renderer rejects origin drift and enabling an unreviewed D1 read flag', async () => {
  const { loadPublicWorkerTarget } = await import('../scripts/v2/render-public-wrangler.mjs');
  const target = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-public-target-'));
  try {
    const drifted = path.join(directory, 'drifted.json');
    fs.writeFileSync(drifted, JSON.stringify({ ...target, workerOrigin: 'https://other.workers.dev' }));
    assert.throws(() => loadPublicWorkerTarget(drifted), /workerOrigin does not match/);
    const enabled = path.join(directory, 'enabled.json');
    fs.writeFileSync(enabled, JSON.stringify({
      ...target,
      d1ReadFlags: { ...target.d1ReadFlags, D1_STANDINGS_ENABLED: true },
    }));
    assert.throws(() => loadPublicWorkerTarget(enabled), /D1_STANDINGS_ENABLED must remain false/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment runs only for main, installs the secret after deploy, and verifies CORS', () => {
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
  assert.equal(render > 0 && deploy > render && secret > deploy && health > secret, true);
  assert.match(workflow, /access-control-allow-origin/);
  assert.match(workflow, /--retry-all-errors/);
  assert.match(workflow, /test "\$status" = '403'/);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('d1 migrations apply'), false);
});
