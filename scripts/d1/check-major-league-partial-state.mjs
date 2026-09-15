#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fixtureImporterModule from './fixture-bundle-importer.js';
import fixedSnapshotModule from './fixed-snapshot.js';

const { validateBundle } = fixtureImporterModule;
const { sha256 } = fixedSnapshotModule;
const REPORT_SCHEMA = 'jfw-d1-major-league-partial-state/1';

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
  const upgrades = new Map();
  for (const item of manifest.fixtureRevisionOverrides || []) {
    if (upgrades.has(item.fixtureId)) throw new Error(`Duplicate expected fixture upgrade: ${item.fixtureId}.`);
    upgrades.set(item.fixtureId, {
      previousRevision: Number(item.previousRevision),
      previousContentSha256: item.previousContentSha256,
      migrationRevision: Number(item.migrationRevision),
    });
  }
  for (const league of manifest.leagues || []) {
    const core = readJson(path.join(root, league.coreArtifact.path));
    const catalog = {
      productSeasonId: core.productSeason?.id,
      source: { apiVersion: core.source?.apiVersion },
      competition: {
        type: core.competition?.type,
        countryCode: core.competition?.countryCode ?? null,
      },
      season: {
        status: core.season?.status,
        startsOn: core.season?.startsOn,
        endsOn: core.season?.endsOn,
        finalizedOn: core.season?.finalizedOn ?? null,
      },
    };
    for (const item of core.fixtures || []) {
      if (fixtures.has(item.fixtureId)) throw new Error(`Duplicate expected fixture: ${item.fixtureId}.`);
      fixtures.set(item.fixtureId, { competitionId: league.competitionId, seasonId: league.seasonId });
    }
    for (const declaration of league.fixtureArtifacts || []) {
      const artifact = readJson(path.join(root, declaration.path));
      const normalized = validateBundle(artifact.bundle, catalog).normalized;
      details.set(declaration.fixtureId, {
        revision: normalized.fixture.revision,
        contentSha256: sha256(normalized),
        upgradeFrom: upgrades.get(declaration.fixtureId) || null,
      });
    }
  }
  for (const [fixtureId, upgrade] of upgrades) {
    const detail = details.get(fixtureId);
    if (!detail || !Number.isInteger(upgrade.previousRevision) || upgrade.previousRevision < 1
      || !Number.isInteger(upgrade.migrationRevision)
      || upgrade.migrationRevision !== upgrade.previousRevision + 1
      || upgrade.migrationRevision !== detail.revision
      || !/^[0-9a-f]{64}$/.test(String(upgrade.previousContentSha256 || ''))) {
      throw new Error(`Invalid expected fixture upgrade: ${fixtureId}.`);
    }
  }
  return { fixtures, details, upgrades };
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
  if (rows.length === 0 && expected.upgrades.size > 0) {
    throw new Error('Required previous fixture revisions are missing from the migration target.');
  }
  if (rows.length === 0) return {
    schemaVersion: REPORT_SCHEMA,
    state: 'clean', passed: true, expectedFixtures: expected.fixtures.size,
    expectedDetails: expected.details.size, storedFixtures: 0, matchedDetails: 0,
    pendingFixtures: expected.fixtures.size, pendingDetails: expected.details.size,
    pendingUpgrades: 0,
    matchedFixtureDetailIds: [],
    pendingFixtureDetailIds: [...expected.details.keys()].sort(),
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
  for (const fixtureId of expected.upgrades.keys()) {
    if (!byFixture.has(fixtureId)) {
      throw new Error(`Required previous fixture revision is missing: ${fixtureId}.`);
    }
  }
  let matchedDetails = 0;
  let pendingUpgrades = 0;
  const matchedFixtureDetailIds = [];
  for (const [fixtureId, fixtureRows] of byFixture) {
    const expectedDetail = expected.details.get(fixtureId);
    const populated = fixtureRows.filter(row => row.revision_no !== null && row.revision_no !== undefined);
    if (!expectedDetail) {
      if (populated.length) throw new Error(`Unexpected detail revision exists for compact fixture: ${fixtureId}.`);
      continue;
    }
    if (populated.length === 0) {
      if (expectedDetail.upgradeFrom) {
        throw new Error(`Required previous fixture revision is missing: ${fixtureId}.`);
      }
      continue;
    }

    const revisionNumbers = new Set();
    for (const row of populated) {
      const revision = Number(row.revision_no);
      if (!Number.isInteger(revision) || revision < 1 || revisionNumbers.has(revision)) {
        throw new Error(`Invalid or duplicate revision history for ${fixtureId}.`);
      }
      revisionNumbers.add(revision);
    }
    const published = populated.filter(row => Number(row.is_published) === 1);
    if (published.length !== 1) {
      throw new Error(`Fixture must have exactly one published revision: ${fixtureId}.`);
    }
    const current = published[0];
    const currentRevision = Number(current.revision_no);
    if (current.lifecycle_state !== 'published') {
      throw new Error(`Published fixture revision has an invalid lifecycle: ${fixtureId}.`);
    }
    for (const row of populated) {
      const revision = Number(row.revision_no);
      if (row === current) continue;
      if (revision >= currentRevision || row.lifecycle_state !== 'superseded'
        || Number(row.is_published) !== 0) {
        throw new Error(`Fixture revision history is inconsistent: ${fixtureId}.`);
      }
    }
    if (currentRevision > expectedDetail.revision) {
      throw new Error(`Fixture has a revision newer than the prepared migration: ${fixtureId}.`);
    }
    if (currentRevision === expectedDetail.revision) {
      if (current.content_sha256 !== expectedDetail.contentSha256) {
        throw new Error(`Fixture hash differs at the prepared revision: ${fixtureId}.`);
      }
      matchedDetails += 1;
      matchedFixtureDetailIds.push(fixtureId);
      continue;
    }
    const upgradeFrom = expectedDetail.upgradeFrom;
    if (!upgradeFrom || currentRevision !== upgradeFrom.previousRevision
      || expectedDetail.revision !== upgradeFrom.migrationRevision
      || current.content_sha256 !== upgradeFrom.previousContentSha256) {
      throw new Error(`Fixture cannot be upgraded directly to the prepared revision: ${fixtureId}.`);
    }
    pendingUpgrades += 1;
  }
  const pendingFixtures = expected.fixtures.size - byFixture.size;
  matchedFixtureDetailIds.sort();
  const matchedFixtureDetailSet = new Set(matchedFixtureDetailIds);
  const pendingFixtureDetailIds = [...expected.details.keys()]
    .filter(fixtureId => !matchedFixtureDetailSet.has(fixtureId)).sort();
  const pendingDetails = pendingFixtureDetailIds.length;
  const complete = pendingFixtures === 0 && pendingDetails === 0;
  return {
    schemaVersion: REPORT_SCHEMA,
    state: complete ? 'complete' : 'compatible-partial',
    passed: true,
    expectedFixtures: expected.fixtures.size,
    expectedDetails: expected.details.size,
    storedFixtures: byFixture.size,
    matchedDetails,
    pendingFixtures,
    pendingDetails,
    pendingUpgrades,
    matchedFixtureDetailIds,
    pendingFixtureDetailIds,
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
