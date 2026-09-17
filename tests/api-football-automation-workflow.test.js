'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(
  __dirname, '..', '.github', 'workflows', 'api-football-automation.yml',
), 'utf8');

test('automation schedule stays behind both repository and reviewed policy gates', () => {
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  assert.match(workflow, /vars\.API_FOOTBALL_AUTOMATION_ENABLED == 'true'/);
  assert.match(workflow, /scheduledSynchronizationEnabled/);
  assert.match(workflow, /RUN API-FOOTBALL AUTOMATION/);
  const policy = require('../config/api-football-automation.json');
  assert.equal(policy.scheduledSynchronizationEnabled, false);
});

test('automation serializes with every staging writer and never executes D1 directly', () => {
  assert.match(workflow, /group: d1-staging-write/);
  assert.doesNotMatch(workflow, /wrangler@4 d1 execute|wrangler d1 execute|migrations apply/);
  assert.match(workflow, /request-admin-ingest\.mjs/);
  assert.match(workflow, /verify-d1-target\.mjs/);
});

test('durable state advances only after Admin Worker verification', () => {
  const admin = workflow.indexOf('request-admin-ingest.mjs');
  const advance = workflow.indexOf('advance-api-football-automation-state.js');
  const upload = workflow.lastIndexOf('$R2_BUCKET/$AUTOMATION_STATE_KEY');
  assert.ok(admin > 0 && advance > admin && upload > advance);
  assert.match(workflow, /steps\.gate\.outputs\.mode == 'execute'/);
});

test('preview performs no R2 or D1 writes', () => {
  const writeSteps = [
    'Reconcile and publish finalized fixture objects to R2',
    'Publish standings objects to R2',
    'Publish through the protected Admin Worker and verify',
    'Advance durable state only after successful verification',
  ];
  for (const name of writeSteps) {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start >= 0);
    assert.match(workflow.slice(start, start + 300), /steps\.gate\.outputs\.mode == 'execute'/);
  }
});
