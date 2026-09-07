#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../../worker/index.mjs';

function optionalArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return path.resolve(argv[index + 1]);
}

function requiredArgument(argv, name) {
  const value = optionalArgument(argv, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
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
  const contract20 = optionalArgument(argv, '--contract-2.0');
  const contract21 = requiredArgument(argv, '--contract-2.1');
  const corrections = requiredArgument(argv, '--corrections');
  const contract20Result = contract20
    ? await probeR2FixtureArtifact(contract20, '2.0.0')
    : null;
  const contract21Result = await probeR2FixtureArtifact(contract21, '2.1.0');
  const correctionsResult = await probeR2FixtureArtifact(corrections, '2.1.0');
  assert.ok(correctionsResult.overrides > 0, 'The correction artifact must have non-empty overrides.');
  assert.ok(correctionsResult.fieldIssues > 0, 'The correction artifact must have non-empty fieldIssues.');

  return {
    verdict: 'PASS',
    contractVersions: {
      '2.0.0': contract20Result
        ? {
            status: 'verified',
            verified: true,
            artifacts: [contract20Result.file],
          }
        : {
            status: 'not_provided',
            verified: false,
            note: 'No real contract 2.0.0 R2 artifact was provided; this version was not verified.',
          },
      '2.1.0': {
        status: 'verified',
        verified: true,
        artifacts: [contract21Result.file, correctionsResult.file],
      },
    },
    artifacts: [contract20Result, contract21Result, correctionsResult].filter(Boolean),
  };
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
