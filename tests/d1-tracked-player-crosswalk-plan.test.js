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
const {
  buildFixtureCoverageManifest,
  reconcileCanonicalFixtureImports,
} = require('../scripts/d1/fixture-coverage');
const { linkFixtureRecords } = require('../scripts/d1/fixture-record-linkage');
const { verifyFixtureRecordParity } = require('../scripts/d1/fixture-record-parity');
const {
  CROSSWALK_METHOD,
  buildTrackedPlayerCrosswalkPlan,
  periodContainsDate,
} = require('../scripts/d1/tracked-player-crosswalk-plan');
const {
  applyTrackedPlayerCrosswalkPlan,
  validatePlan,
} = require('../scripts/d1/tracked-player-crosswalk-executor');
const {
  importTrackedPlayerRatings,
  ratingCandidate,
} = require('../scripts/d1/tracked-player-rating-importer');
const {
  rebuildTrackedPlayerAggregates,
} = require('../scripts/d1/tracked-player-aggregate-rebuilder');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const CONTENT_SHA256 = 'a'.repeat(64);

function snapshot(options = {}) {
  const authoredRating = Object.hasOwn(options, 'jfwRating')
    ? { jfwRating: options.jfwRating, ratingVersion: options.ratingVersion || '1.0' }
    : {};
  return buildFixedSnapshot({
    baseData: {
      updated: '2026-08-27T00:00:00.000Z',
      players: [{
        playerId: 'jp:one',
        name: 'One',
        club: 'Home FC',
        league: 'Premier League',
        providerIds: options.conflictingPlayerId
          ? { apiFootball: { player: options.conflictingPlayerId } }
          : undefined,
        membershipHistory: options.memberships || [{
          club: 'Home FC', league: 'Premier League', from: '2026-07-01', to: null,
          tracked: true, changeType: 'initial',
        }],
        seasonStats: { apps: 1, goals: 0 },
      }],
      matches: [],
      playerMatchStats: [],
    },
    basePath: 'data.json',
    fragments: [{
      playerMatchStats: [{
        recordId: 'record:verified',
        playerId: 'jp:one',
        matchId: 'match:verified',
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
        ...authoredRating,
      }],
    }],
    fragmentNames: ['data/test.json'],
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: '2026-27', label: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });
}

function aggregateSnapshot() {
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
        matchId: 'match:verified',
        ko: '2026-08-22 05:00 JST',
        league: 'Premier League',
        round: '第1節',
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
      }],
    }],
    fragmentNames: ['data/test.json'],
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: '2026-27', label: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });
}

function canonicalDatabase(fixedSnapshot, file = ':memory:') {
  const database = new DatabaseSync(file);
  database.exec(migration);
  importFixedSnapshot(database, fixedSnapshot);
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
      kickoff_utc, date_jst, status_short, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 2, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'finalized'
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

function parityCoverage(database, fixedSnapshot) {
  const imported = reconcileCanonicalFixtureImports(buildFixtureCoverageManifest(fixedSnapshot), {
    schemaVersion: 'd1-canonical-fixture-import-report/1',
    fixtures: [{ fixtureId: 'af:fixture:9001', status: 'imported', contentSha256: CONTENT_SHA256 }],
  });
  return verifyFixtureRecordParity(
    database,
    fixedSnapshot,
    linkFixtureRecords(database, fixedSnapshot, imported),
  );
}

function resolveCrosswalk(database, fixedSnapshot, coverage) {
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  return applyTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage, plan);
}

test('exact provider player, team, competition and period evidence produces an executable resolution', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, parityCoverage(database, fixedSnapshot));

  assert.equal(plan.productionReady, false);
  assert.deepEqual(plan.summary, {
    trackedPlayers: 1,
    readyPlayers: 1,
    deferredPlayers: 0,
    ambiguousPlayers: 0,
    alreadyResolvedPlayers: 0,
    resolutionPlanComplete: true,
    crosswalkGatePassed: false,
  });
  assert.equal(plan.players[0].status, 'ready');
  assert.deepEqual(plan.players[0].resolution, {
    jfwPlayerId: 'jp:one',
    playerCanonicalId: 'af:player:1001',
    method: CROSSWALK_METHOD,
    memberships: [{
      legacyMembershipId: 1,
      teamCanonicalId: 'af:team:40',
      competitionSeasonCanonicalId: 'af:season:39:2026',
      verification: 'provider',
    }],
  });
  assert.deepEqual(plan.players[0].periods[0].candidates[0].evidenceRecordIds, ['record:verified']);
});

test('a period without in-range exact evidence stays deferred', t => {
  const fixedSnapshot = snapshot({
    memberships: [{
      club: 'Home FC', league: 'Premier League', from: '2026-09-01', to: null,
      tracked: true, changeType: 'initial',
    }],
  });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, parityCoverage(database, fixedSnapshot));

  assert.equal(plan.players[0].status, 'deferred');
  assert.deepEqual(plan.players[0].reasons, ['period_mapping_incomplete']);
  assert.equal(plan.players[0].periods[0].reason, 'exact_period_evidence_missing');
  assert.equal(plan.summary.resolutionPlanComplete, false);
});

test('conflicting snapshot provider player IDs are ambiguous and never emit a resolution', t => {
  const fixedSnapshot = snapshot({ conflictingPlayerId: 2002 });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, parityCoverage(database, fixedSnapshot));

  assert.equal(plan.players[0].status, 'ambiguous');
  assert.deepEqual(plan.players[0].providerPlayerIds, [1001, 2002]);
  assert.deepEqual(plan.players[0].reasons, ['provider_player_id_conflict']);
  assert.equal(Object.hasOwn(plan.players[0], 'resolution'), false);
});

test('coverage links are rebuilt from published D1 instead of trusting artifact fields', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  coverage.records[0].recordLink.canonicalTeamId = 'af:team:50';

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  assert.equal(plan.players[0].status, 'ready');
  assert.equal(plan.players[0].resolution.memberships[0].teamCanonicalId, 'af:team:40');
});

test('fact parity is recomputed and closes the plan after canonical fact drift', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  database.exec('UPDATE fixture_player_stats SET goals = 1 WHERE player_appearance_id = 1');
  assert.equal(database.prepare('SELECT goals FROM fixture_player_stats').get().goals, 1);
  const reverified = verifyFixtureRecordParity(
    database,
    fixedSnapshot,
    linkFixtureRecords(database, fixedSnapshot, coverage),
  );
  assert.equal(reverified.records[0].factParity.state, 'failed');

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);

  assert.equal(plan.players[0].status, 'deferred');
  assert.deepEqual(plan.players[0].reasons, [
    'fact_parity_passed_record_missing',
    'period_mapping_incomplete',
  ]);
  assert.equal(plan.players[0].factParityPassedRecords, 0);
});

test('stale published bundle linkage becomes deferred without retaining old parity', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  database.exec(`UPDATE fixture_revisions SET content_sha256 = '${'b'.repeat(64)}' WHERE id = 1`);

  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);

  assert.equal(plan.players[0].status, 'deferred');
  assert.deepEqual(plan.players[0].reasons, [
    'canonical_player_link_missing',
    'fact_parity_passed_record_missing',
    'period_mapping_incomplete',
  ]);
});

test('period bounds are half-open so a change date belongs only to the new membership', () => {
  assert.equal(periodContainsDate({ validFrom: '2026-07-01', validTo: '2026-08-22' }, '2026-08-22'), false);
  assert.equal(periodContainsDate({ validFrom: '2026-08-22', validTo: '9999-12-31' }, '2026-08-22'), true);
});

test('executor applies an exact ready plan atomically and replays without new writes', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);

  const first = applyTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage, plan);
  const counts = {
    syncRuns: database.prepare(`SELECT COUNT(*) AS count FROM sync_runs
      WHERE run_type = 'tracked_player_crosswalk_apply'`).get().count,
    memberships: database.prepare('SELECT COUNT(*) AS count FROM player_team_memberships').get().count,
    legacy: database.prepare('SELECT COUNT(*) AS count FROM legacy_tracking_memberships').get().count,
  };
  const second = applyTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage, plan);

  assert.equal(first.productionReady, false);
  assert.deepEqual(first.summary, {
    plannedReadyPlayers: 1,
    resolvedPlayers: 1,
    alreadyResolvedPlayers: 0,
    deferredPlayers: 0,
    stalePlayers: 0,
    failedPlayers: 0,
    remainingDeferredPlayers: 0,
    remainingAmbiguousPlayers: 0,
    crosswalkGatePassed: true,
  });
  assert.equal(first.players[0].resolvedPeriods, 1);
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = 'jp:one'`).get().crosswalk_state, 'resolved');
  assert.deepEqual(counts, { syncRuns: 1, memberships: 1, legacy: 0 });
  assert.equal(second.syncRunId, null);
  assert.equal(second.players[0].status, 'already_resolved');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM sync_runs
    WHERE run_type = 'tracked_player_crosswalk_apply'`).get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM player_team_memberships').get().count, 1);
});

test('executor rejects a stale or tampered ready resolution without writes', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  plan.players[0].resolution.memberships[0].teamCanonicalId = 'af:team:50';

  const report = applyTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage, plan);

  assert.equal(report.syncRunId, null);
  assert.equal(report.summary.stalePlayers, 1);
  assert.equal(report.players[0].reason, 'planned_resolution_no_longer_matches_current_evidence');
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = 'jp:one'`).get().crosswalk_state, 'unresolved');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM player_team_memberships').get().count, 0);
});

test('executor contains a resolver failure and rolls back that complete player', t => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  database.exec(`CREATE TRIGGER reject_crosswalk BEFORE UPDATE OF player_id ON tracked_players
    BEGIN SELECT RAISE(ABORT, 'test crosswalk rejection'); END`);

  const report = applyTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage, plan);

  assert.equal(report.summary.failedPlayers, 1);
  assert.match(report.players[0].error, /test crosswalk rejection/);
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = 'jp:one'`).get().crosswalk_state, 'unresolved');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM player_team_memberships').get().count, 0);
  assert.equal(database.prepare(`SELECT status FROM sync_runs
    WHERE id = ?1`).get(report.syncRunId).status, 'completed_with_errors');
});

test('plan validation rejects snapshot drift and resolutions on non-ready players', () => {
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot);
  const coverage = parityCoverage(database, fixedSnapshot);
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  database.close();

  const wrongSnapshot = structuredClone(plan);
  wrongSnapshot.snapshot.artifactSha256 = 'b'.repeat(64);
  assert.match(validatePlan(wrongSnapshot, fixedSnapshot).join('\n'), /does not belong/);

  const invalidState = structuredClone(plan);
  invalidState.players[0].status = 'deferred';
  assert.match(validatePlan(invalidState, fixedSnapshot).join('\n'), /only ready players/);
});

test('apply CLI writes a deterministic report and updates the supplied database', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-crosswalk-apply-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshotPath = path.join(temporary, 'snapshot.json');
  const coveragePath = path.join(temporary, 'coverage.json');
  const planPath = path.join(temporary, 'plan.json');
  const reportPath = path.join(temporary, 'report.json');
  const databasePath = path.join(temporary, 'local.sqlite3');
  const fixedSnapshot = snapshot();
  const database = canonicalDatabase(fixedSnapshot, databasePath);
  const coverage = parityCoverage(database, fixedSnapshot);
  const plan = buildTrackedPlayerCrosswalkPlan(database, fixedSnapshot, coverage);
  database.close();
  fs.writeFileSync(snapshotPath, JSON.stringify(fixedSnapshot));
  fs.writeFileSync(coveragePath, JSON.stringify(coverage));
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const applied = childProcess.spawnSync(process.execPath, [
    'scripts/d1/apply-tracked-player-crosswalk.js',
    '--snapshot', snapshotPath,
    '--coverage', coveragePath,
    '--database', databasePath,
    '--plan', planPath,
    '--report', reportPath,
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => verified.close());
  assert.equal(report.summary.resolvedPlayers, 1);
  assert.equal(report.productionReady, false);
  assert.equal(verified.prepare(`SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = 'jp:one'`).get().crosswalk_state, 'resolved');
});

test('rating importer preserves an authored numeric Rating and is idempotent', t => {
  const fixedSnapshot = snapshot({ jfwRating: 6.25 });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);

  const first = importTrackedPlayerRatings(database, fixedSnapshot, coverage);
  const second = importTrackedPlayerRatings(database, fixedSnapshot, coverage);
  const stored = database.prepare(`SELECT rating, rating_state, rating_version, inputs_json
    FROM jfw_rating_results`).get();

  assert.equal(first.summary.importedRatings, 1);
  assert.equal(first.summary.publishedRatings, 1);
  assert.equal(first.summary.ratingGatePassed, true);
  assert.equal(first.productionReady, false);
  assert.equal(second.summary.importedRatings, 0);
  assert.equal(second.summary.alreadyImportedRatings, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jfw_rating_results').get().count, 1);
  assert.equal(stored.rating, 6.25);
  assert.equal(stored.rating_state, 'computed');
  assert.equal(stored.rating_version, '1.0');
  assert.equal(JSON.parse(stored.inputs_json).authoredState, 'authored_value');
});

test('authored null is stored as missing while undefined remains deferred', t => {
  const authoredNull = snapshot({ jfwRating: null });
  const database = canonicalDatabase(authoredNull);
  t.after(() => database.close());
  const coverage = parityCoverage(database, authoredNull);
  resolveCrosswalk(database, authoredNull, coverage);

  const report = importTrackedPlayerRatings(database, authoredNull, coverage);
  const stored = database.prepare(`SELECT rating, rating_state, inputs_json
    FROM jfw_rating_results`).get();

  assert.equal(report.summary.importedRatings, 1);
  assert.equal(stored.rating, null);
  assert.equal(stored.rating_state, 'missing');
  assert.equal(JSON.parse(stored.inputs_json).authoredState, 'authored_null');
  assert.deepEqual(ratingCandidate({ ratingVersion: '1.0' }), {
    state: 'deferred', reason: 'authored_rating_missing',
  });
  assert.deepEqual(ratingCandidate({}), {
    state: 'not_applicable', reason: 'authored_rating_not_declared',
  });
  assert.deepEqual(ratingCandidate({ jfwRating: 6.25 }), {
    state: 'deferred', reason: 'authored_rating_version_missing',
  });
});

test('rating import remains deferred until the exact tracked player crosswalk is resolved', t => {
  const fixedSnapshot = snapshot({ jfwRating: 6.25 });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);

  const report = importTrackedPlayerRatings(database, fixedSnapshot, coverage);

  assert.equal(report.summary.deferredRatings, 1);
  assert.equal(report.records[0].reason, 'tracked_player_crosswalk_not_resolved');
  assert.equal(report.summary.ratingGatePassed, false);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jfw_rating_results').get().count, 0);
});

test('rating import requires the exact active Core tracking period for the fixture', t => {
  const fixedSnapshot = snapshot({ jfwRating: 6.25 });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  database.exec(`UPDATE tracking_periods SET tracking_status = 'inactive'
    WHERE jfw_player_id = 'jp:one'`);

  const report = importTrackedPlayerRatings(database, fixedSnapshot, coverage);

  assert.equal(report.summary.deferredRatings, 1);
  assert.equal(report.records[0].reason, 'canonical_tracking_period_not_matched');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jfw_rating_results').get().count, 0);
});

test('an existing conflicting Rating is reported and never overwritten', t => {
  const fixedSnapshot = snapshot({ jfwRating: 6.25 });
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  importTrackedPlayerRatings(database, fixedSnapshot, coverage);
  database.exec(`UPDATE jfw_rating_results SET source_hash = '${'b'.repeat(64)}'`);

  const report = importTrackedPlayerRatings(database, fixedSnapshot, coverage);

  assert.equal(report.summary.failedRatings, 1);
  assert.match(report.records[0].error, /conflicts_with_fixed_snapshot/);
  assert.equal(database.prepare('SELECT rating FROM jfw_rating_results').get().rating, 6.25);
  assert.equal(database.prepare('SELECT source_hash FROM jfw_rating_results').get().source_hash, 'b'.repeat(64));
});

test('rating import CLI persists the authored-null distinction in its report and D1', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-rating-import-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshotPath = path.join(temporary, 'snapshot.json');
  const coveragePath = path.join(temporary, 'coverage.json');
  const reportPath = path.join(temporary, 'report.json');
  const databasePath = path.join(temporary, 'local.sqlite3');
  const fixedSnapshot = snapshot({ jfwRating: null });
  const database = canonicalDatabase(fixedSnapshot, databasePath);
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  database.close();
  fs.writeFileSync(snapshotPath, JSON.stringify(fixedSnapshot));
  fs.writeFileSync(coveragePath, JSON.stringify(coverage));

  const imported = childProcess.spawnSync(process.execPath, [
    'scripts/d1/import-tracked-player-ratings.js',
    '--snapshot', snapshotPath,
    '--coverage', coveragePath,
    '--database', databasePath,
    '--report', reportPath,
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  assert.equal(imported.status, 0, imported.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => verified.close());
  assert.equal(report.records[0].ratingState, 'missing');
  assert.equal(verified.prepare('SELECT rating FROM jfw_rating_results').get().rating, null);
});

test('aggregate rebuild replaces the legacy season row with four canonical scopes and is idempotent', t => {
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);

  const first = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);
  const second = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);
  const rows = database.prepare(`SELECT aggregate_scope, stats_json
    FROM tracked_player_aggregates ORDER BY aggregate_scope`).all();
  const season = JSON.parse(rows.find(item => item.aggregate_scope === 'season').stats_json);

  assert.equal(first.summary.rebuiltPlayers, 1);
  assert.equal(first.summary.aggregateParityGatePassed, true);
  assert.equal(first.productionReady, false);
  assert.equal(second.summary.alreadyRebuiltPlayers, 1);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(item => item.aggregate_scope),
    ['club', 'club_competition', 'competition', 'season']);
  assert.equal(season.stats.apps, 1);
  assert.equal(season.stats.starts, 1);
  assert.equal(season.stats.minutes, 90);
  assert.equal(season.stats.goals, 0);
  assert.equal(season.stats.assists, null);
  assert.deepEqual(season.provenance.canonicalRecordIds, ['record:verified']);
});

test('aggregate rebuild remains deferred until the tracked player crosswalk is resolved', t => {
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  const legacy = database.prepare(`SELECT stats_json, source_hash FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season'`).get();

  const report = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);
  const stored = database.prepare(`SELECT stats_json, source_hash FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season'`).get();

  assert.equal(report.summary.deferredPlayers, 1);
  assert.equal(report.players[0].reason, 'tracked_player_crosswalk_not_resolved');
  assert.equal(report.summary.aggregateParityGatePassed, false);
  assert.deepEqual({ ...stored }, { ...legacy });
});

test('aggregate rebuild rejects a Core competition season outside the fixed product season', t => {
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  database.exec(`
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (2, 'jfw:season:2025-26', '2025-26', '2025-07-01', '2026-06-30');
    UPDATE competition_seasons SET product_season_id = 2 WHERE id = 1;
  `);

  const report = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);

  assert.equal(report.summary.deferredPlayers, 1);
  assert.equal(report.players[0].reason, 'canonical_tracking_scope_not_matched');
  assert.equal(report.summary.aggregateParityGatePassed, false);
});

test('aggregate parity catches canonical enrichment that record parity does not compare', t => {
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  database.exec('UPDATE fixture_player_stats SET assists = 1');

  const report = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);
  const stored = JSON.parse(database.prepare(`SELECT stats_json FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season'`).get().stats_json);

  assert.equal(report.summary.failedPlayers, 1);
  assert.equal(report.players[0].reason, 'aggregate_stats_parity_mismatch');
  assert.equal(report.players[0].actual.assists, 1);
  assert.equal(report.players[0].expected.assists, null);
  assert.ok(stored.seasonStats);
});

test('a conflicting rebuilt aggregate is reported and never overwritten', t => {
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot);
  t.after(() => database.close());
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);
  database.exec(`UPDATE tracked_player_aggregates SET source_hash = '${'b'.repeat(64)}'
    WHERE aggregate_scope = 'season'`);

  const report = rebuildTrackedPlayerAggregates(database, fixedSnapshot, coverage);

  assert.equal(report.summary.failedPlayers, 1);
  assert.match(report.players[0].reason, /aggregate_conflicts_with_existing_row/);
  assert.equal(database.prepare(`SELECT source_hash FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season'`).get().source_hash, 'b'.repeat(64));
});

test('aggregate rebuild CLI writes a stable report and canonical aggregate rows', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-aggregate-rebuild-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshotPath = path.join(temporary, 'snapshot.json');
  const coveragePath = path.join(temporary, 'coverage.json');
  const reportPath = path.join(temporary, 'report.json');
  const databasePath = path.join(temporary, 'local.sqlite3');
  const fixedSnapshot = aggregateSnapshot();
  const database = canonicalDatabase(fixedSnapshot, databasePath);
  const coverage = parityCoverage(database, fixedSnapshot);
  resolveCrosswalk(database, fixedSnapshot, coverage);
  database.close();
  fs.writeFileSync(snapshotPath, JSON.stringify(fixedSnapshot));
  fs.writeFileSync(coveragePath, JSON.stringify(coverage));

  const rebuilt = childProcess.spawnSync(process.execPath, [
    'scripts/d1/rebuild-tracked-player-aggregates.js',
    '--snapshot', snapshotPath,
    '--coverage', coveragePath,
    '--database', databasePath,
    '--report', reportPath,
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => verified.close());
  assert.equal(report.summary.aggregateParityGatePassed, true);
  assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM tracked_player_aggregates').get().count, 4);
});
