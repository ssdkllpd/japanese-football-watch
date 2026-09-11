#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fixtureShadowModule from './fixture-shadow-compare.js';
import fixedSnapshotModule from './fixed-snapshot.js';

const { normalizeFixtureBundle } = fixtureShadowModule;
const { sha256 } = fixedSnapshotModule;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[item.slice(2)] = true;
    else { result[item.slice(2)] = next; index += 1; }
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function inventoryRows(payload) {
  if (Array.isArray(payload?.[0]?.results)) return payload[0].results;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload)) return payload;
  throw new Error('D1 fixture inventory has no results array.');
}

export function expectedState(preparedRoot) {
  const root = path.resolve(preparedRoot);
  const manifest = readJson(path.join(root, 'migration-manifest.json'));
  const fixtures = new Map();
  const details = new Map();
  for (const league of manifest.leagues || []) {
    const core = readJson(path.join(root, league.coreArtifact.path));
    for (const item of core.fixtures || []) {
      if (fixtures.has(item.fixtureId)) throw new Error(`Duplicate expected fixture: ${item.fixtureId}.`);
      fixtures.set(item.fixtureId, { competitionId: league.competitionId, seasonId: league.seasonId });
    }
    for (const declaration of league.fixtureArtifacts || []) {
      const artifact = readJson(path.join(root, declaration.path));
      const normalized = normalizeFixtureBundle(artifact.bundle);
      details.set(declaration.fixtureId, {
        revision: normalized.fixture.revision,
        contentSha256: sha256(normalized),
      });
    }
  }
  return { fixtures, details };
}

export function partialStateQuery(preparedRoot) {
  const expected = expectedState(preparedRoot);
  const seasonIds = [...new Set([...expected.fixtures.values()].map(item => item.seasonId))].sort();
  if (!seasonIds.length || seasonIds.some(value => !/^af:season:\d+:\d+$/.test(value))) {
    throw new Error('Prepared migration contains an invalid season scope.');
  }
  const quoted = seasonIds.map(value => `'${value}'`).join(', ');
  return `SELECT fixture.canonical_id AS fixture_id, competition.canonical_id AS competition_id,\n`
    + `  season.canonical_id AS season_id, revision.revision_no, revision.lifecycle_state,\n`
    + `  revision.content_sha256,\n`
    + `  CASE WHEN fixture.published_revision = revision.id THEN 1 ELSE 0 END AS is_published\n`
    + `FROM fixtures fixture\n`
    + `JOIN competition_seasons season ON season.id = fixture.competition_season_id\n`
    + `JOIN competitions competition ON competition.id = season.competition_id\n`
    + `LEFT JOIN fixture_revisions revision ON revision.fixture_id = fixture.id\n`
    + `WHERE season.canonical_id IN (${quoted})\n`
    + `ORDER BY fixture.canonical_id, revision.revision_no;\n`;
}

export function detectPartialState(preparedRoot, payload) {
  const expected = expectedState(preparedRoot);
  const rows = inventoryRows(payload);
  if (rows.length === 0) return {
    state: 'clean', passed: true, expectedFixtures: expected.fixtures.size,
    expectedDetails: expected.details.size, storedFixtures: 0, matchedDetails: 0,
  };

  const byFixture = new Map();
  for (const row of rows) {
    if (!expected.fixtures.has(row.fixture_id)) {
      throw new Error(`Unexpected fixture exists in migration scope: ${row.fixture_id}.`);
    }
    const scope = expected.fixtures.get(row.fixture_id);
    if (row.competition_id !== scope.competitionId || row.season_id !== scope.seasonId) {
      throw new Error(`Fixture scope differs from prepared migration: ${row.fixture_id}.`);
    }
    if (!byFixture.has(row.fixture_id)) byFixture.set(row.fixture_id, []);
    byFixture.get(row.fixture_id).push(row);
  }
  if (byFixture.size !== expected.fixtures.size) {
    throw new Error(`Partial migration fixture set detected (${byFixture.size}/${expected.fixtures.size}).`);
  }

  let matchedDetails = 0;
  for (const [fixtureId, fixtureRows] of byFixture) {
    const expectedDetail = expected.details.get(fixtureId);
    const populated = fixtureRows.filter(row => row.revision_no !== null && row.revision_no !== undefined);
    if (!expectedDetail) {
      if (populated.length) throw new Error(`Unexpected detail revision exists for compact fixture: ${fixtureId}.`);
      continue;
    }
    if (populated.length !== 1) throw new Error(`Unexpected revision count for ${fixtureId}: ${populated.length}.`);
    const row = populated[0];
    if (row.revision_no !== expectedDetail.revision
      || row.content_sha256 !== expectedDetail.contentSha256
      || row.lifecycle_state !== 'published' || Number(row.is_published) !== 1) {
      throw new Error(`Fixture revision/hash/publication differs from prepared migration: ${fixtureId}.`);
    }
    matchedDetails += 1;
  }
  if (matchedDetails !== expected.details.size) {
    throw new Error(`Partial migration detail set detected (${matchedDetails}/${expected.details.size}).`);
  }
  return {
    state: 'complete', passed: true, expectedFixtures: expected.fixtures.size,
    expectedDetails: expected.details.size, storedFixtures: byFixture.size, matchedDetails,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prepared) throw new Error('--prepared is required.');
  if (args['write-query']) {
    fs.writeFileSync(path.resolve(args['write-query']), partialStateQuery(args.prepared));
    return;
  }
  if (!args.inventory) throw new Error('--inventory is required unless --write-query is used.');
  process.stdout.write(`${JSON.stringify(detectPartialState(args.prepared, readJson(args.inventory)))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
