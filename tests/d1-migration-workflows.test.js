'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('admin wrangler renderer accepts only bounded resource identities and never emits secrets or public flags', async t => {
  const { renderAdminWrangler } = await import('../scripts/d1/render-admin-wrangler.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-wrangler-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'wrangler.toml');
  const env = {
    ADMIN_WORKER_NAME: 'jfw-football-admin-ingest-staging',
    R2_BUCKET: 'jfw-football-data',
    D1_DATABASE_NAME: 'jfw-football-staging',
    D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
    ADMIN_INGEST_TOKEN: 'must-not-appear',
  };
  const rendered = renderAdminWrangler(env, output);
  assert.match(rendered, /name = "jfw-football-admin-ingest-staging"/);
  assert.match(rendered, /compatibility_flags = \["nodejs_compat"\]/);
  assert.match(rendered, /migrations_dir = /);
  assert.match(rendered, /binding = "FOOTBALL_DB"/);
  assert.match(rendered, /binding = "FOOTBALL_DATA"/);
  assert.equal(rendered.includes(env.ADMIN_INGEST_TOKEN), false);
  assert.equal(rendered.includes('D1_DATE_INDEX_ENABLED'), false);

  assert.throws(() => renderAdminWrangler({
    ...env, ADMIN_WORKER_NAME: 'valid"\nD1_FIXTURE_DETAIL_ENABLED = "true',
  }, output), /ADMIN_WORKER_NAME/);
  assert.throws(() => renderAdminWrangler({
    ...env, D1_DATABASE_ID: 'not-a-database-id',
  }, output), /D1_DATABASE_ID/);
});

test('staging provision workflow applies migrations before deploying only the admin Worker', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'd1-staging-provision.yml'), 'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: d1-staging/);
  const migrate = workflow.indexOf('d1 migrations apply');
  const deploy = workflow.indexOf('wrangler@4 deploy');
  const secret = workflow.indexOf('secret put ADMIN_INGEST_TOKEN');
  assert.equal(migrate > 0 && deploy > migrate && secret > deploy, true);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('D1_DATE_INDEX_ENABLED = "true"'), false);
  assert.equal(workflow.includes('--config worker/wrangler'), false);
});

test('staging bootstrap workflow rebuilds the reviewed bytes and writes D1 only through admin ingest', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'd1-staging-bootstrap.yml'), 'utf8',
  );
  assert.match(workflow, /environment: d1-staging/);
  assert.match(workflow, /bfda9fa6e3bfdc5abaf1e37ffe1dc9962b7a557756be08bc3d1c366c4ba1fe49/);
  assert.match(workflow, /migration\/fixed-snapshots\/\$FIXED_SNAPSHOT_SHA256\.json/);
  assert.match(workflow, /request-admin-ingest\.mjs/);
  assert.match(workflow, /fixedSnapshot:/);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('d1 migrations apply'), false);
  assert.equal(workflow.includes('D1_FIXTURE_DETAIL_ENABLED'), false);
});

test('staging data migration executes a repository plan only through the admin endpoint', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'd1-staging-data-migrate.yml'), 'utf8',
  );
  assert.match(workflow, /environment: d1-staging/);
  assert.match(workflow, /plan_path:/);
  assert.match(workflow, /plan_path escapes the repository/);
  assert.match(workflow, /request-admin-ingest\.mjs/);
  assert.equal(workflow.includes('CLOUDFLARE_API_TOKEN'), false);
  assert.equal(workflow.includes('wrangler'), false);
  assert.equal(workflow.includes('d1 execute'), false);
  assert.equal(workflow.includes('production'), false);
});

test('standings publisher mirrors to D1 only behind an explicit disabled-by-default admin gate', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'v2-standings.yml'), 'utf8',
  );
  assert.match(workflow, /D1_ADMIN_PUBLISH_ENABLED/);
  assert.match(workflow, /mirror-standings-to-d1:[\s\S]*id: target/);
  assert.match(workflow, /if: steps\.target\.outputs\.enabled == 'true'/);
  assert.match(workflow, /environment: d1-staging/);
  const r2Job = workflow.slice(
    workflow.indexOf('ingest-standings:'), workflow.indexOf('mirror-standings-to-d1:'),
  );
  assert.equal(r2Job.includes('ADMIN_INGEST_TOKEN'), false);
  assert.match(workflow, /request-admin-ingest\.mjs/);
  assert.equal(workflow.includes('d1 execute'), false);
});

test('fixture publishers mirror to D1 only after R2 publication from protected jobs', () => {
  for (const [name, sourceJob, mirrorJob] of [
    ['v2-fixture-vertical-slice.yml', 'export-and-publish:', 'mirror-fixture-to-d1:'],
    ['v2-date-feed.yml', 'ingest-date:', 'mirror-date-feed-to-d1:'],
  ]) {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    const lastR2Put = workflow.lastIndexOf('r2 object put');
    const plan = workflow.indexOf('create-v2-admin-plan.js');
    const publish = workflow.indexOf('request-admin-ingest.mjs');
    assert.equal(lastR2Put > 0 && plan > lastR2Put && publish > plan, true, name);
    assert.match(workflow, /id: target/);
    assert.match(workflow, /if: steps\.target\.outputs\.enabled == 'true'/);
    assert.match(workflow, /environment: d1-staging/);
    const r2Job = workflow.slice(workflow.indexOf(sourceJob), workflow.indexOf(mirrorJob));
    assert.equal(r2Job.includes('ADMIN_INGEST_TOKEN'), false, name);
    assert.equal(workflow.includes('d1 execute'), false, name);
  }
});

test('target verifier requires exact reviewed resource identities and endpoint origin', async t => {
  const { verifyD1Target } = await import('../scripts/d1/verify-d1-target.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-target-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'targets.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 'jfw-d1-targets/1',
    targets: {
      staging: {
        environment: 'd1-staging',
        d1DatabaseName: 'reviewed-database-name',
        d1DatabaseId: '12345678-1234-1234-1234-123456789abc',
        adminWorkerName: 'reviewed-worker-name',
        r2BucketName: 'reviewed-r2-bucket',
        adminEndpointOrigin: 'https://reviewed-admin.example.test',
      },
    },
  }));
  const env = {
    D1_DATABASE_NAME: 'reviewed-database-name',
    D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
    ADMIN_WORKER_NAME: 'reviewed-worker-name',
    R2_BUCKET: 'reviewed-r2-bucket',
    ADMIN_INGEST_URL: 'https://reviewed-admin.example.test/admin/ingest',
  };
  assert.equal(verifyD1Target({ env, manifestPath }).adminWorkerName, 'reviewed-worker-name');
  for (const [key, value] of [
    ['D1_DATABASE_NAME', 'other-database'],
    ['D1_DATABASE_ID', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['ADMIN_WORKER_NAME', 'other-worker'],
    ['R2_BUCKET', 'other-bucket'],
    ['ADMIN_INGEST_URL', 'https://other.example.test/admin/ingest'],
  ]) {
    assert.throws(() => verifyD1Target({ env: { ...env, [key]: value }, manifestPath }),
      /does not exactly match/, key);
  }
});

test('the committed target manifest locks the independently reviewed staging identities', async () => {
  const { loadD1Target } = await import('../scripts/d1/verify-d1-target.mjs');
  assert.deepEqual(loadD1Target(path.join(root, 'config', 'd1-targets.json')), {
    environment: 'd1-staging',
    d1DatabaseName: 'jfw-football-staging',
    d1DatabaseId: 'fdfd74e4-2702-4aa2-ab20-c062e952fe25',
    adminWorkerName: 'jfw-football-admin-ingest-staging',
    r2BucketName: 'jfw-football-data',
    adminEndpointOrigin: 'https://jfw-football-admin-ingest-staging.ssdkllpd.workers.dev',
  });
});

test('all six staging write workflows prove the same exact target before their first D1 write', () => {
  const workflows = [
    ['d1-staging-provision.yml', 'd1 migrations apply'],
    ['d1-staging-bootstrap.yml', 'r2 object put'],
    ['d1-staging-data-migrate.yml', 'request-admin-ingest.mjs'],
    ['v2-standings.yml', 'request-admin-ingest.mjs'],
    ['v2-fixture-vertical-slice.yml', 'request-admin-ingest.mjs'],
    ['v2-date-feed.yml', 'request-admin-ingest.mjs'],
  ];
  for (const [name, firstWrite] of workflows) {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    const proof = workflow.indexOf('verify-d1-target.mjs --manifest config/d1-targets.json --target staging');
    const write = workflow.indexOf(firstWrite);
    assert.equal(proof > 0 && write > proof, true, name);
    assert.match(workflow, /environment: d1-staging/, name);
    for (const key of [
      'ADMIN_WORKER_NAME', 'D1_DATABASE_NAME', 'D1_DATABASE_ID', 'R2_BUCKET', 'ADMIN_INGEST_URL',
    ]) assert.match(workflow, new RegExp(`${key}: \\$\\{\\{ vars\\.${key} \\}\\}`), `${name}:${key}`);
    assert.equal(workflow.includes('D1_TARGET_ENVIRONMENT'), false, name);
  }
  const renderer = fs.readFileSync(path.join(root, 'scripts', 'd1', 'render-admin-wrangler.mjs'), 'utf8');
  assert.equal(renderer.includes('.includes(targetEnvironment)'), false);
});

test('migrations keep foreign key enforcement active for local SQLite drivers', () => {
  const { DatabaseSync } = require('node:sqlite');
  const files = ['0001_d1_core.sql', '0002_d1_date_index_coverage.sql',
    '0003_d1_standings_publication.sql', '0004_d1_standings_order_and_fixture_date.sql'];
  const database = new DatabaseSync(':memory:');
  for (const file of files) database.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => database.exec(
    "INSERT INTO competition_seasons(canonical_id, competition_id, provider_season, label, status)"
    + " VALUES ('af:season:9999:2026', 9999, 2026, 'x', 'active')"), /FOREIGN KEY/);
  database.close();
});
