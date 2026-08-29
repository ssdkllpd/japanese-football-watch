'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { buildFixedSnapshot } = require('../scripts/d1/fixed-snapshot');
const { importFixedSnapshot } = require('../scripts/d1/fixed-snapshot-importer');
const { buildFixtureCoverageManifest, reconcileCanonicalFixtureImports } = require('../scripts/d1/fixture-coverage');
const { linkFixtureRecords } = require('../scripts/d1/fixture-record-linkage');
const { verifyFixtureRecordParity } = require('../scripts/d1/fixture-record-parity');
const { FixtureRepository } = require('../scripts/d1/fixture-repository');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { buildTrackedPlayerCrosswalkPlan } = require('../scripts/d1/tracked-player-crosswalk-plan');
const { applyTrackedPlayerCrosswalkPlan } = require('../scripts/d1/tracked-player-crosswalk-executor');
const { importTrackedPlayerRatings, verifyTrackedPlayerRatings } = require('../scripts/d1/tracked-player-rating-importer');
const {
  rebuildTrackedPlayerAggregates,
  verifyTrackedPlayerAggregates,
} = require('../scripts/d1/tracked-player-aggregate-rebuilder');
const {
  PHASE2_PLAN_SCHEMA_VERSION,
  evaluatePhase2Readiness,
  validatePhase2ReadinessPlan,
} = require('../scripts/d1/phase2-readiness');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const CONTENT_SHA256 = 'a'.repeat(64);

function fixedSnapshot() {
  return buildFixedSnapshot({
    baseData: {
      updated: '2026-08-20 00:00 JST',
      players: [{
        playerId: 'jp:one',
        name: 'One',
        club: 'Home FC',
        league: 'Premier League',
        membershipHistory: [{
          club: 'Home FC', league: 'Premier League', from: '2026-07-01', to: null,
          tracked: true, changeType: 'initial',
        }],
        seasonStats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 },
      }],
      matches: [{
        matchId: 'match:verified', ko: '2026-08-22 05:00 JST',
        league: 'Premier League', round: '第1節',
      }],
      playerMatchStats: [],
    },
    basePath: 'data.json',
    fragments: [{
      playerMatchStats: [{
        recordId: 'record:verified',
        playerId: 'jp:one',
        matchId: 'match:verified',
        club: 'Home FC',
        competition: 'Premier League',
        ko: '2026-08-22 05:00 JST',
        appearance: true,
        start: true,
        bench: false,
        trackedAtMatch: true,
        minutes: 90,
        goals: 0,
        ratingInputs: {
          minutes: { state: 'value', value: 90 },
          goals: { state: 'value', value: 0 },
        },
        providerRatings: { apiFootball: { value: 7.1 } },
        providerIds: { apiFootball: { fixture: 9001, player: 1001, team: 40, league: 39 } },
        jfwRating: 6.25,
        ratingVersion: '1.0',
      }],
    }],
    fragmentNames: ['data/test.json'],
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: '2026-27', label: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });
}

function canonicalDatabase(snapshot, file = ':memory:') {
  const database = new DatabaseSync(file);
  database.exec(migration);
  importFixedSnapshot(database, snapshot);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (2, 'api-football', 'v3');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 2, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:40', 2, 40, 'Home FC'),
      (2, 'af:team:50', 2, 50, 'Away FC');
    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
      VALUES (1, 'af:player:1001', 2, 1001, 'One');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, home_team_id, away_team_id,
      kickoff_utc, date_jst, status_short, status_long, round, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 2, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'Match Finished', '第1節', 'finalized'
    );
    INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES (
      1, 1, 1, 'published', 'd1', '${CONTENT_SHA256}',
      '2026-08-21T21:00:00.000Z', '2026-08-21T21:01:00.000Z'
    );
    UPDATE fixtures SET published_revision = 1 WHERE id = 1;
    INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
      VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z');
    INSERT INTO fixture_player_appearances(
      id, fixture_revision_id, player_record_id, appearance_state, position, minutes, captain
    ) VALUES (1, 1, 1, 'started', 'F', 90, 0);
    INSERT INTO fixture_player_stats(player_appearance_id, minutes, provider_rating, goals)
      VALUES (1, 90, 7.1, 0);
  `);
  return database;
}

function parityCoverage(database, snapshot) {
  const imported = reconcileCanonicalFixtureImports(buildFixtureCoverageManifest(snapshot), {
    schemaVersion: 'd1-canonical-fixture-import-report/1',
    fixtures: [{ fixtureId: 'af:fixture:9001', status: 'imported', contentSha256: CONTENT_SHA256 }],
  });
  return verifyFixtureRecordParity(database, snapshot,
    linkFixtureRecords(database, snapshot, imported));
}

function migrateTrackingFacts(database, snapshot, coverage) {
  const plan = buildTrackedPlayerCrosswalkPlan(database, snapshot, coverage);
  applyTrackedPlayerCrosswalkPlan(database, snapshot, coverage, plan);
  importTrackedPlayerRatings(database, snapshot, coverage);
  rebuildTrackedPlayerAggregates(database, snapshot, coverage);
}

async function readinessArtifacts(database, directory) {
  const resolved = await new FixtureRepository(createLocalD1(database)).resolveFixture('af:fixture:9001');
  const fixturePath = path.join(directory, 'fixture-9001.json');
  fs.writeFileSync(fixturePath, JSON.stringify(resolved.bundle));
  return {
    fixturePath,
    plan: {
      schemaVersion: PHASE2_PLAN_SCHEMA_VERSION,
      fixtures: [{ fixtureId: 'af:fixture:9001', jsonPath: path.basename(fixturePath) }],
    },
  };
}

test('Phase 2 readiness recomputes every gate without writes and remains pending formal review', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-phase2-ready-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  const artifacts = await readinessArtifacts(database, temporary);
  const changesBefore = database.prepare('SELECT total_changes() AS count').get().count;

  const report = await evaluatePhase2Readiness(database, snapshot, coverage, artifacts.plan, {
    baseDirectory: temporary,
  });

  assert.deepEqual(report.gates, {
    fixtureRecords: true,
    fixtureShadows: true,
    trackedPlayerCrosswalks: true,
    jfwRatings: true,
    trackedPlayerAggregates: true,
  });
  assert.equal(report.phase2TechnicalGatePassed, true);
  assert.equal(report.productionReady, false);
  assert.equal(report.phase3CutoverReady, false);
  assert.deepEqual(report.remainingGates, ['claude_formal_review']);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changesBefore);
});

test('Rating and aggregate verifiers detect tampering without repairing D1', t => {
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  database.exec(`
    UPDATE jfw_rating_results SET source_hash = '${'b'.repeat(64)}';
    UPDATE tracked_player_aggregates SET source_hash = '${'c'.repeat(64)}'
      WHERE aggregate_scope = 'season';
  `);

  const ratings = verifyTrackedPlayerRatings(database, snapshot, coverage);
  const aggregates = verifyTrackedPlayerAggregates(database, snapshot, coverage);

  assert.equal(ratings.summary.ratingGatePassed, false);
  assert.equal(ratings.records[0].reason, 'stored_rating_does_not_match_fixed_snapshot');
  assert.equal(aggregates.summary.aggregateParityGatePassed, false);
  assert.match(aggregates.players[0].reason, /stored_aggregate_does_not_match/);
  assert.equal(database.prepare('SELECT source_hash FROM jfw_rating_results').get().source_hash, 'b'.repeat(64));
  assert.equal(database.prepare(`SELECT source_hash FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season'`).get().source_hash, 'c'.repeat(64));
});

test('readiness ignores stale artifact linkage and recomputes published D1 evidence', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-phase2-stale-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  const artifacts = await readinessArtifacts(database, temporary);
  coverage.records[0].recordLink.canonicalPlayerId = 'af:player:999999';

  const report = await evaluatePhase2Readiness(database, snapshot, coverage, artifacts.plan, {
    baseDirectory: temporary,
  });

  assert.equal(report.gates.fixtureRecords, true);
  assert.equal(report.gates.trackedPlayerCrosswalks, true);
  assert.equal(report.phase2TechnicalGatePassed, true);
});

test('fresh D1 shadow mismatch closes only the shadow gate', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-phase2-shadow-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  const artifacts = await readinessArtifacts(database, temporary);
  const bundle = JSON.parse(fs.readFileSync(artifacts.fixturePath, 'utf8'));
  bundle.fixture.status.long = 'Tampered';
  fs.writeFileSync(artifacts.fixturePath, JSON.stringify(bundle));

  const report = await evaluatePhase2Readiness(database, snapshot, coverage, artifacts.plan, {
    baseDirectory: temporary,
  });

  assert.equal(report.gates.fixtureRecords, true);
  assert.equal(report.gates.fixtureShadows, false);
  assert.equal(report.gates.jfwRatings, true);
  assert.equal(report.gates.trackedPlayerAggregates, true);
  assert.equal(report.phase2TechnicalGatePassed, false);
  assert.ok(report.remainingGates.includes('fixtureShadows'));
});

test('resolved crosswalk drift closes the crosswalk gate', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-phase2-crosswalk-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  const artifacts = await readinessArtifacts(database, temporary);
  database.exec(`UPDATE tracking_periods SET valid_from = '2026-07-02'
    WHERE jfw_player_id = 'jp:one'`);

  const report = await evaluatePhase2Readiness(database, snapshot, coverage, artifacts.plan, {
    baseDirectory: temporary,
  });

  assert.equal(report.gates.trackedPlayerCrosswalks, false);
  assert.equal(report.trackedPlayerCrosswalks.players[0].reason,
    'resolved_crosswalk_does_not_match_current_evidence');
  assert.equal(report.phase2TechnicalGatePassed, false);
});

test('Phase 2 readiness plan validation and CLI are deterministic', async t => {
  assert.match(validatePhase2ReadinessPlan({ schemaVersion: PHASE2_PLAN_SCHEMA_VERSION, fixtures: [] })
    .join('\n'), /non-empty/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-phase2-cli-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshotPath = path.join(temporary, 'snapshot.json');
  const coveragePath = path.join(temporary, 'coverage.json');
  const planPath = path.join(temporary, 'plan.json');
  const reportPath = path.join(temporary, 'report.json');
  const databasePath = path.join(temporary, 'local.sqlite3');
  const snapshot = fixedSnapshot();
  const database = canonicalDatabase(snapshot, databasePath);
  const coverage = parityCoverage(database, snapshot);
  migrateTrackingFacts(database, snapshot, coverage);
  const artifacts = await readinessArtifacts(database, temporary);
  database.close();
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  fs.writeFileSync(coveragePath, JSON.stringify(coverage));
  fs.writeFileSync(planPath, JSON.stringify(artifacts.plan));

  const verified = childProcess.spawnSync(process.execPath, [
    'scripts/d1/verify-phase2-readiness.js',
    '--snapshot', snapshotPath,
    '--coverage', coveragePath,
    '--database', databasePath,
    '--plan', planPath,
    '--report', reportPath,
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  assert.equal(verified.status, 0, verified.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.phase2TechnicalGatePassed, true);
  assert.equal(report.productionReady, false);
});
