'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { buildFixedSnapshot, stableStringify } = require('../scripts/d1/fixed-snapshot');
const {
  buildFixtureCoverageManifest,
  reconcileCanonicalFixtureImports,
} = require('../scripts/d1/fixture-coverage');
const { linkFixtureRecords } = require('../scripts/d1/fixture-record-linkage');
const {
  compareLegacyRecordFacts,
  verifyFixtureRecordParity,
} = require('../scripts/d1/fixture-record-parity');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const CONTENT_SHA256 = 'a'.repeat(64);

function snapshot(options = {}) {
  return buildFixedSnapshot({
    baseData: {
      updated: '2026-08-27T00:00:00.000Z',
      players: [{
        playerId: 'jp:one', name: 'One', club: 'Home FC', league: 'Premier League',
        seasonStats: { apps: 1, goals: 0 },
      }],
      matches: [{ matchId: 'match:verified', providerIds: { apiFootball: { fixture: 9001 } } }],
      playerMatchStats: [],
    },
    basePath: 'data.json',
    fragments: [{
      playerMatchStats: [{
        recordId: 'record:verified', playerId: 'jp:one', matchId: 'match:verified',
        appearance: true, start: true, bench: false, values: { goals: 0 },
        ratingInputs: options.ratingInputs || {
          minutes: { state: 'value', value: 90 },
          goals: { state: 'value', value: 0 },
        },
        providerRatings: { apiFootball: { value: 7.1 } },
        providerIds: options.providerIds === false ? undefined : {
          apiFootball: { player: 1001, team: options.providerTeamId || 40 },
        },
      }],
    }],
    fragmentNames: ['data/test.json'],
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: '2026-27', label: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });
}

function importedCoverage(fixedSnapshot, contentSha256 = CONTENT_SHA256) {
  return reconcileCanonicalFixtureImports(buildFixtureCoverageManifest(fixedSnapshot), {
    schemaVersion: 'd1-canonical-fixture-import-report/1',
    fixtures: [{ fixtureId: 'af:fixture:9001', status: 'imported', contentSha256 }],
  });
}

function createDatabase(file = ':memory:', options = {}) {
  const database = new DatabaseSync(file);
  database.exec(migration);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC'),
      (2, 'af:team:50', 1, 50, 'Away FC');
    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
      VALUES (1, 'af:player:1001', 1, 1001, 'One');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, home_team_id, away_team_id,
      kickoff_utc, date_jst, status_short, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'finalized'
    );
    INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES (
      1, 1, 1, 'published', 'd1', '${options.contentSha256 || CONTENT_SHA256}',
      '2026-08-21T21:00:00.000Z', '2026-08-21T21:01:00.000Z'
    );
    UPDATE fixtures SET published_revision = 1 WHERE id = 1;
  `);
  if (options.playerRecord !== false) {
    database.exec(`
      INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
        VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z');
      INSERT INTO fixture_player_appearances(
        id, fixture_revision_id, player_record_id, appearance_state, position, minutes, captain
      ) VALUES (1, 1, 1, 'started', 'F', 90, 0);
      INSERT INTO fixture_player_stats(player_appearance_id, minutes, provider_rating, goals)
        VALUES (1, 90, 7.1, 0);
    `);
  }
  return database;
}

test('verified fixture/player IDs link one legacy record to the published canonical appearance', t => {
  const database = createDatabase();
  t.after(() => database.close());
  const fixedSnapshot = snapshot();

  const linked = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot));
  const record = linked.records[0];

  assert.equal(linked.productionReady, false);
  assert.equal(linked.summary.productionReadyRecords, 0);
  assert.equal(linked.summary.recordLinkedRecords, 1);
  assert.equal(linked.summary.recordLinkPendingRecords, 0);
  assert.equal(linked.summary.recordLinkCompleteFixtures, 1);
  assert.equal(record.importState, 'deferred');
  assert.equal(record.reason, 'canonical_record_linked_fact_parity_pending');
  assert.deepEqual(record.recordLink, {
    state: 'linked',
    method: 'provider_fixture_player_id',
    canonicalFixtureId: 'af:fixture:9001',
    canonicalPlayerId: 'af:player:1001',
    canonicalTeamId: 'af:team:40',
    providerPlayerId: 1001,
    providerTeamId: 40,
    playerRecordId: 1,
    publishedRevision: 1,
    appearanceState: 'started',
    hasPlayerStats: true,
  });
  assert.equal(linked.fixtures[0].recordLinkage.state, 'complete');
});

test('linkage fails closed for missing player evidence, team conflicts, and bundle hash drift', t => {
  const database = createDatabase();
  t.after(() => database.close());

  const missingPlayer = snapshot({ providerIds: false });
  const missingResult = linkFixtureRecords(database, missingPlayer, importedCoverage(missingPlayer));
  assert.equal(missingResult.records[0].reason, 'canonical_provider_player_id_missing');

  const wrongTeam = snapshot({ providerTeamId: 50 });
  const wrongTeamResult = linkFixtureRecords(database, wrongTeam, importedCoverage(wrongTeam));
  assert.equal(wrongTeamResult.records[0].reason, 'canonical_player_team_mismatch');

  const fixedSnapshot = snapshot();
  const drifted = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot, 'b'.repeat(64)));
  assert.equal(drifted.records[0].reason, 'canonical_published_bundle_mismatch');
  assert.equal(drifted.summary.recordLinkedRecords, 0);
});

test('a canonical player without a published fixture appearance is not linked by identity alone', t => {
  const database = createDatabase(':memory:', { playerRecord: false });
  t.after(() => database.close());
  const fixedSnapshot = snapshot();

  const linked = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot));

  assert.equal(linked.records[0].reason, 'canonical_player_record_missing');
  assert.equal(linked.fixtures[0].recordLinkage.state, 'incomplete');
  assert.equal(linked.productionReady, false);
});

test('duplicate legacy records for one fixture/player remain unresolved', t => {
  const database = createDatabase();
  t.after(() => database.close());
  const fixedSnapshot = snapshot();
  const duplicate = structuredClone(fixedSnapshot.data.playerMatchStats[0]);
  duplicate.recordId = 'record:duplicate';
  fixedSnapshot.data.playerMatchStats.push(duplicate);
  const { sha256 } = require('../scripts/d1/fixed-snapshot');
  const { inputSha256: ignored, ...payload } = fixedSnapshot;
  fixedSnapshot.inputSha256 = sha256(payload);

  const linked = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot));

  assert.equal(linked.summary.recordLinkedRecords, 0);
  assert.deepEqual(linked.records.map(record => record.reason), [
    'duplicate_legacy_fixture_player_records',
    'duplicate_legacy_fixture_player_records',
  ]);
});

test('safe mapped values and appearance state pass fact parity without opening production', t => {
  const database = createDatabase();
  t.after(() => database.close());
  const fixedSnapshot = snapshot();
  const linked = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot));

  const verified = verifyFixtureRecordParity(database, fixedSnapshot, linked);
  const record = verified.records[0];

  assert.equal(record.factParity.state, 'passed');
  assert.equal(record.factParity.compared, 3);
  assert.equal(record.factParity.matched, 3);
  assert.deepEqual(record.factParity.mismatches, []);
  assert.equal(record.reason, 'canonical_record_parity_verified_tracking_crosswalk_pending');
  assert.equal(verified.summary.factParityPassedRecords, 1);
  assert.equal(verified.summary.factParityGatePassed, true);
  assert.equal(verified.fixtures[0].factParity.state, 'complete');
  assert.equal(verified.productionReady, false);
  assert.equal(verified.summary.productionReadyRecords, 0);
});

test('explicit zero does not match canonical null or a different value', t => {
  const database = createDatabase();
  t.after(() => database.close());
  database.exec('UPDATE fixture_player_stats SET goals = NULL WHERE player_appearance_id = 1');
  const fixedSnapshot = snapshot();
  const linked = linkFixtureRecords(database, fixedSnapshot, importedCoverage(fixedSnapshot));

  const verified = verifyFixtureRecordParity(database, fixedSnapshot, linked);
  const mismatch = verified.records[0].factParity.mismatches.find(item => item.legacyField === 'goals');

  assert.equal(verified.records[0].factParity.state, 'failed');
  assert.deepEqual(mismatch, {
    legacyField: 'goals', canonicalField: 'goals', kind: 'canonical_missing',
    legacy: 0, canonical: null, canonicalPresence: 'unknown',
  });
  assert.equal(verified.records[0].reason, 'canonical_record_fact_parity_mismatch');
  assert.equal(verified.summary.factParityFailedRecords, 1);
  assert.equal(verified.productionReady, false);
});

test('unsupported semantics stay outside parity while same-source pass accuracy remains comparable', () => {
  const result = compareLegacyRecordFacts({
    ratingInputs: {
      passesCompleted: { state: 'value', value: 25 },
      straightRed: { state: 'value', value: 0 },
      saves: { state: 'missing' },
    },
    providerRatings: { apiFootball: { value: 7.1 } },
  }, {
    appearanceState: 'unknown',
    values: { passAccuracy: 25, saves: null, rating: 7.1 },
    fieldStates: { saves: 'not_applicable' },
  });

  assert.equal(result.state, 'partial');
  assert.equal(result.compared, 2);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.notCompared, [{
    legacyField: 'straightRed', legacyState: 'value', reason: 'no_safe_canonical_mapping',
  }]);
  assert.deepEqual(result.missingOnBoth, [{
    legacyField: 'saves', canonicalField: 'saves', canonicalPresence: 'not_applicable',
  }]);
});

test('top-level core facts remain comparable when legacy ratingInputs are absent', () => {
  const result = compareLegacyRecordFacts({ minutes: 0, goals: 0, assists: 0 }, {
    appearanceState: 'unknown',
    values: { minutes: 0, goals: 0, assists: 0 },
    fieldStates: {},
  });

  assert.equal(result.state, 'passed');
  assert.equal(result.compared, 3);
  assert.equal(result.matched, 3);
});

test('canonical enrichment stays partial until its migration effect is reviewed', () => {
  const result = compareLegacyRecordFacts({
    ratingInputs: {
      goals: { state: 'value', value: 0 },
      shots: { state: 'missing' },
    },
  }, {
    appearanceState: 'unknown',
    values: { goals: 0, shots: 2 },
    fieldStates: {},
  });

  assert.equal(result.state, 'partial');
  assert.deepEqual(result.canonicalEnrichments, [{ legacyField: 'shots', canonicalField: 'shots', canonical: 2 }]);
});

test('record-link CLI is deterministic and opens no production gate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-record-link-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'd1.sqlite3');
  createDatabase(databasePath).close();
  const fixedSnapshot = snapshot();
  const coverage = importedCoverage(fixedSnapshot);
  const snapshotPath = path.join(directory, 'snapshot.json');
  const coveragePath = path.join(directory, 'coverage.json');
  fs.writeFileSync(snapshotPath, stableStringify(fixedSnapshot));
  fs.writeFileSync(coveragePath, stableStringify(coverage));
  const cli = path.join(__dirname, '..', 'scripts', 'd1', 'link-fixture-records.js');
  const outputs = [path.join(directory, 'first.json'), path.join(directory, 'second.json')];

  for (const output of outputs) {
    const result = spawnSync(process.execPath, [
      cli, '--snapshot', snapshotPath, '--coverage', coveragePath,
      '--database', databasePath, '--output', output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      recordLinkedRecords: 1,
      recordLinkPendingRecords: 0,
      productionReady: false,
    });
  }
  assert.equal(fs.readFileSync(outputs[0], 'utf8'), fs.readFileSync(outputs[1], 'utf8'));

  const parityCli = path.join(__dirname, '..', 'scripts', 'd1', 'verify-fixture-record-parity.js');
  const parityOutput = path.join(directory, 'parity.json');
  const parity = spawnSync(process.execPath, [
    parityCli, '--snapshot', snapshotPath, '--coverage', outputs[0],
    '--database', databasePath, '--output', parityOutput,
  ], { encoding: 'utf8' });
  assert.equal(parity.status, 0, parity.stderr);
  assert.deepEqual(JSON.parse(parity.stdout), {
    factParityPassedRecords: 1,
    factParityPartialRecords: 0,
    factParityFailedRecords: 0,
    factParityGatePassed: true,
    productionReady: false,
  });
  assert.equal(JSON.parse(fs.readFileSync(parityOutput, 'utf8')).productionReady, false);
});
