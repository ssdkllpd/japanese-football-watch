'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('the R2 artifact probe exercises 2.0, 2.1 and non-empty correction shapes through flag off', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-r2-probe-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const { contractSamples } = require('../scripts/d1/generate-fixture-detail-contract');
  const current = structuredClone(contractSamples()[0]);
  current.fieldIssues['fixture.referee'] = ['conflict'];
  const legacy = structuredClone(current);
  legacy.contractVersion = '2.0.0';
  delete legacy.detailAvailability;
  const legacyPath = path.join(temporaryDirectory, 'contract-2.0.json');
  const currentPath = path.join(temporaryDirectory, 'contract-2.1.json');
  fs.writeFileSync(legacyPath, JSON.stringify(legacy));
  fs.writeFileSync(currentPath, JSON.stringify(current));

  const { run } = await import('../scripts/d1/probe-r2-fixture-artifacts.mjs');
  const report = await run([
    '--contract-2.0', legacyPath,
    '--contract-2.1', currentPath,
    '--corrections', currentPath,
  ]);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.contractVersions['2.0.0'].status, 'verified');
  assert.equal(report.contractVersions['2.0.0'].verified, true);
  assert.equal(report.contractVersions['2.1.0'].status, 'verified');
  assert.equal(report.contractVersions['2.1.0'].verified, true);
  assert.deepEqual(report.artifacts.map(item => item.contractVersion), ['2.0.0', '2.1.0', '2.1.0']);
  assert.ok(report.artifacts[2].overrides > 0);
  assert.ok(report.artifacts[2].fieldIssues > 0);
});

test('the R2 artifact probe permits an absent 2.0 artifact without claiming it was verified', async t => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-r2-probe-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const { contractSamples } = require('../scripts/d1/generate-fixture-detail-contract');
  const current = structuredClone(contractSamples()[0]);
  current.fieldIssues['fixture.referee'] = ['conflict'];
  const currentPath = path.join(temporaryDirectory, 'contract-2.1.json');
  fs.writeFileSync(currentPath, JSON.stringify(current));

  const { run } = await import('../scripts/d1/probe-r2-fixture-artifacts.mjs');
  const report = await run([
    '--contract-2.1', currentPath,
    '--corrections', currentPath,
  ]);
  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(report.contractVersions['2.0.0'], {
    status: 'not_provided',
    verified: false,
    note: 'No real contract 2.0.0 R2 artifact was provided; this version was not verified.',
  });
  assert.equal(report.contractVersions['2.1.0'].status, 'verified');
  assert.equal(report.contractVersions['2.1.0'].verified, true);
  assert.deepEqual(report.artifacts.map(item => item.contractVersion), ['2.1.0', '2.1.0']);
});
