#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../../worker/index.mjs';

function requiredArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required.`);
  return path.resolve(argv[index + 1]);
}

function r2Object(payload) {
  const body = JSON.stringify(payload);
  return {
    body,
    httpMetadata: { contentType: 'application/json' },
    async text() { return body; },
  };
}

async function readArtifact(filePath) {
  const bytes = await readFile(filePath);
  return {
    filePath,
    payload: JSON.parse(bytes.toString('utf8')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function probeR2FixtureArtifact(filePath, expectedContractVersion) {
  const artifact = await readArtifact(filePath);
  const fixtureId = artifact.payload?.fixture?.id;
  assert.equal(artifact.payload?.contractVersion, expectedContractVersion);
  assert.equal(typeof fixtureId, 'string');
  assert.notEqual(fixtureId, '');

  const pointerKey = `football/v2/indexes/fixture/${fixtureId}.json`;
  const artifactKey = `probe/fixtures/${encodeURIComponent(fixtureId)}.json`;
  const objects = new Map([
    [pointerKey, r2Object({ fixtureId, key: artifactKey })],
    [artifactKey, r2Object(artifact.payload)],
  ]);
  const environment = {
    APP_ORIGINS: 'https://probe.example',
    D1_FIXTURE_DETAIL_ENABLED: 'false',
    FOOTBALL_DB: { prepare() { throw new Error('flag-off probe must not read D1'); } },
    FOOTBALL_DATA: { async get(key) { return objects.get(key) || null; } },
  };
  const request = new Request(
    `https://worker.example/api/v2/fixtures/${encodeURIComponent(fixtureId)}`,
    { headers: { origin: 'https://probe.example' } },
  );
  const response = await worker.fetch(request, environment, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2');
  assert.deepEqual(body, artifact.payload);

  return {
    file: path.basename(filePath),
    fixtureId,
    contractVersion: artifact.payload.contractVersion,
    sha256: artifact.sha256,
    overrides: Object.keys(artifact.payload.overrides || {}).length,
    fieldIssues: Object.keys(artifact.payload.fieldIssues || {}).length,
  };
}

export async function run(argv = process.argv.slice(2)) {
  const contract20 = requiredArgument(argv, '--contract-2.0');
  const contract21 = requiredArgument(argv, '--contract-2.1');
  const corrections = requiredArgument(argv, '--corrections');
  const results = [
    await probeR2FixtureArtifact(contract20, '2.0.0'),
    await probeR2FixtureArtifact(contract21, '2.1.0'),
    await probeR2FixtureArtifact(corrections, '2.1.0'),
  ];
  assert.ok(results[2].overrides > 0, 'The correction artifact must have non-empty overrides.');
  assert.ok(results[2].fieldIssues > 0, 'The correction artifact must have non-empty fieldIssues.');
  return { verdict: 'PASS', artifacts: results };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then(
    report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    },
  );
}
