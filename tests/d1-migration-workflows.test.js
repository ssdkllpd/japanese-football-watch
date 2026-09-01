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
    ADMIN_WORKER_NAME: 'jfw-football-admin-ingest',
    R2_BUCKET: 'jfw-football-data',
    D1_DATABASE_NAME: 'jfw-football-staging',
    D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
    ADMIN_INGEST_TOKEN: 'must-not-appear',
  };
  const rendered = renderAdminWrangler(env, output);
  assert.match(rendered, /name = "jfw-football-admin-ingest"/);
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
  assert.match(workflow, /mirror-standings-to-d1:[\s\S]*if: vars\.D1_ADMIN_PUBLISH_ENABLED == 'true'/);
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
    assert.match(workflow, /if: vars\.D1_ADMIN_PUBLISH_ENABLED == 'true'/);
    assert.match(workflow, /environment: d1-staging/);
    const r2Job = workflow.slice(workflow.indexOf(sourceJob), workflow.indexOf(mirrorJob));
    assert.equal(r2Job.includes('ADMIN_INGEST_TOKEN'), false, name);
    assert.equal(workflow.includes('d1 execute'), false, name);
  }
});
