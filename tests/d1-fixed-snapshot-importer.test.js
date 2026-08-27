'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  artifactSha256,
  buildFixedSnapshot,
  currentSnapshotInputs,
  validateFixedSnapshot,
} = require('../scripts/d1/fixed-snapshot');
const {
  importFixedSnapshot,
  resolveTrackedPlayerCrosswalk,
  validateImportedSnapshot,
} = require('../scripts/d1/fixed-snapshot-importer');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const CREATED_AT = '2026-08-27T12:00:00.000Z';
const SEASON = {
  id: '2026-27',
  label: '2026-27',
  startsOn: '2026-07-01',
  endsOn: '2027-06-30',
};

function sampleBase() {
  return {
    updated: '2026-08-27 21:00 JST',
    dataCoverage: [],
    topMatches: [],
    matches: [],
    gaResults: [],
    insights: [],
    analysis: [],
    players: [
      {
        playerId: 'jp:unresolved',
        name: 'Unresolved Player',
        club: 'ブライトン',
        league: 'プレミアリーグ',
        pos: 'MF',
        trackingStatus: 'active',
        membershipHistory: [{
          club: 'ブライトン',
          league: 'プレミアリーグ',
          from: null,
          to: null,
          tracked: true,
          changeType: 'initial',
        }],
        seasonStats: { apps: 0, goals: 0, assists: null },
        stats: { apps: 0, goals: 0, assists: null },
        allCompetitionsStats: { apps: 0, goals: 0, assists: null },
        competitionStats: {},
        clubStats: {},
      },
      {
        playerId: 'jp:ambiguous',
        name: 'Ambiguous Player',
        club: 'リーズ',
        league: 'プレミアリーグ',
        pos: 'FW',
        trackingStatus: 'active',
        membershipHistory: [{
          club: 'リーズ',
          league: 'プレミアリーグ',
          from: '2026-07-01',
          to: null,
          tracked: true,
          changeType: 'initial',
        }],
        seasonStats: { apps: 1, goals: 1, assists: 0 },
        stats: { apps: 1, goals: 1, assists: 0 },
        allCompetitionsStats: { apps: 1, goals: 1, assists: 0 },
        competitionStats: {},
        clubStats: {},
      },
    ],
    playerMatchStats: [{
      recordId: 'record:1',
      playerId: 'jp:ambiguous',
      playerName: 'Ambiguous Player',
      goals: 1,
      assists: 0,
    }],
  };
}

function sampleSnapshot(overrides = {}) {
  return buildFixedSnapshot({
    baseData: sampleBase(),
    basePath: 'data.json',
    createdAt: overrides.createdAt || CREATED_AT,
    fragmentNames: [],
    fragments: [],
    season: SEASON,
  });
}

function openDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  return database;
}

test('current backfill produces and idempotently imports one deterministic first-pass fixed snapshot', t => {
  const inputs = currentSnapshotInputs(path.join(__dirname, '..'));
  const options = {
    ...inputs,
    createdAt: CREATED_AT,
    season: SEASON,
  };

  const first = buildFixedSnapshot(options);
  const second = buildFixedSnapshot(options);

  assert.equal(first.inputSha256, second.inputSha256);
  assert.equal(first.data.players.length, 64);
  assert.equal(first.data.playerMatchStats.length, 118);
  assert.deepEqual(validateFixedSnapshot(first), []);
  assert.equal(first.inputs.fragments.length, inputs.fragmentNames.length);

  const database = openDatabase();
  t.after(() => database.close());
  const expectedMemberships = first.data.players
    .reduce((total, player) => total + (player.membershipHistory || []).length, 0);
  const imported = importFixedSnapshot(database, first);
  const replay = importFixedSnapshot(database, first);
  assert.equal(imported.trackedPlayerCount, 64);
  assert.equal(imported.membershipCount, expectedMemberships);
  assert.equal(replay.imported, false);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count, 64);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tracking_periods').get().count, expectedMemberships);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM players').get().count, 0);
  const sourcePlayer = first.data.players.find(player => player.playerId === 'jp-1vfimc3');
  const stored = JSON.parse(database.prepare(`SELECT stats_json FROM tracked_player_aggregates
    WHERE jfw_player_id = 'jp-1vfimc3'`).get().stats_json);
  assert.deepEqual(stored.clubStats, sourcePlayer.clubStats);
  assert.deepEqual(stored.competitionStats, sourcePlayer.competitionStats);
  assert.deepEqual(validateImportedSnapshot(database, first), []);
});

test('fixed snapshot rejects content changes and duplicate membership replay', () => {
  const tampered = sampleSnapshot();
  tampered.data.players[0].seasonStats.goals = 99;
  assert.match(validateFixedSnapshot(tampered).join('\n'), /inputSha256 does not match/);

  const duplicate = sampleSnapshot();
  duplicate.data.players[0].membershipHistory.push({
    ...duplicate.data.players[0].membershipHistory[0],
  });
  assert.match(validateFixedSnapshot(duplicate).join('\n'), /duplicate legacy membership/);
});

test('import is atomic, preserves zero versus null, and is idempotent by input hash', t => {
  const database = openDatabase();
  t.after(() => database.close());
  const snapshot = sampleSnapshot();

  const first = importFixedSnapshot(database, snapshot, {
    crosswalks: { 'jp:ambiguous': { state: 'ambiguous', method: 'reviewed_name_collision' } },
  });
  const countsAfterFirst = {
    players: database.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count,
    memberships: database.prepare('SELECT COUNT(*) AS count FROM legacy_tracking_memberships').get().count,
    periods: database.prepare('SELECT COUNT(*) AS count FROM tracking_periods').get().count,
    aggregates: database.prepare('SELECT COUNT(*) AS count FROM tracked_player_aggregates').get().count,
  };
  const second = importFixedSnapshot(database, snapshot);
  const countsAfterSecond = {
    players: database.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count,
    memberships: database.prepare('SELECT COUNT(*) AS count FROM legacy_tracking_memberships').get().count,
    periods: database.prepare('SELECT COUNT(*) AS count FROM tracking_periods').get().count,
    aggregates: database.prepare('SELECT COUNT(*) AS count FROM tracked_player_aggregates').get().count,
  };

  assert.equal(first.imported, true);
  assert.equal(first.deferredLegacyMatchRecords, 1);
  assert.equal(first.productionReady, false);
  assert.equal(second.imported, false);
  assert.deepEqual(countsAfterFirst, { players: 2, memberships: 2, periods: 2, aggregates: 2 });
  assert.deepEqual(countsAfterSecond, countsAfterFirst);
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players WHERE jfw_player_id = 'jp:unresolved'`).get().crosswalk_state, 'unresolved');
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players WHERE jfw_player_id = 'jp:ambiguous'`).get().crosswalk_state, 'ambiguous');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM players').get().count, 0);
  const stats = JSON.parse(database.prepare(`SELECT stats_json FROM tracked_player_aggregates
    WHERE jfw_player_id = 'jp:ambiguous'`).get().stats_json);
  assert.equal(stats.seasonStats.apps, 1);
  assert.equal(stats.seasonStats.goals, 1);
  assert.equal(stats.seasonStats.assists, 0);
  assert.equal(stats.seasonStats.starts, null);
  assert.deepEqual(validateImportedSnapshot(database, snapshot), []);
});

test('a different snapshot cannot be replayed over an imported fixed input', t => {
  const database = openDatabase();
  t.after(() => database.close());
  importFixedSnapshot(database, sampleSnapshot());
  const changed = sampleSnapshot({ createdAt: '2026-08-27T12:01:00.000Z' });

  assert.throws(() => importFixedSnapshot(database, changed), /different fixed snapshot is already imported/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM raw_snapshots').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tracking_periods').get().count, 2);
});

test('invalid membership period rolls back the complete import', t => {
  const database = openDatabase();
  t.after(() => database.close());
  const invalid = sampleSnapshot();
  invalid.data.players[0].membershipHistory[0].from = '2027-01-02';
  invalid.data.players[0].membershipHistory[0].to = '2027-01-01';

  assert.throws(() => importFixedSnapshot(database, invalid), /Invalid fixed snapshot/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM raw_snapshots').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count, 0);
});

test('resolved crosswalk switches every period to Core membership in one transaction', t => {
  const database = openDatabase();
  t.after(() => database.close());
  const snapshot = sampleSnapshot();
  importFixedSnapshot(database, snapshot);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (2, 'api-football', 'v3');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
    VALUES (1, 'af:competition:39', 2, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name)
    VALUES (1, 'af:team:40', 2, 40, 'Core Home');
    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
    VALUES (1, 'af:player:1001', 2, 1001, 'Unresolved Player');
  `);
  const legacyId = database.prepare(`SELECT id FROM legacy_tracking_memberships
    WHERE jfw_player_id = 'jp:unresolved'`).get().id;

  const result = resolveTrackedPlayerCrosswalk(database, {
    jfwPlayerId: 'jp:unresolved',
    playerCanonicalId: 'af:player:1001',
    method: 'provider_id',
    memberships: [{
      legacyMembershipId: legacyId,
      teamCanonicalId: 'af:team:40',
      competitionSeasonCanonicalId: 'af:season:39:2026',
      verification: 'verified',
    }],
  });

  const tracked = database.prepare(`SELECT crosswalk_state, player_id FROM tracked_players
    WHERE jfw_player_id = 'jp:unresolved'`).get();
  const period = database.prepare(`SELECT core_membership_id, legacy_membership_id, competition_season_id
    FROM tracking_periods WHERE jfw_player_id = 'jp:unresolved'`).get();
  assert.equal(result.resolvedPeriods, 1);
  assert.deepEqual({ ...tracked }, { crosswalk_state: 'resolved', player_id: 1 });
  assert.equal(period.core_membership_id > 0, true);
  assert.equal(period.legacy_membership_id, null);
  assert.equal(period.competition_season_id, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM legacy_tracking_memberships
    WHERE jfw_player_id = 'jp:unresolved'`).get().count, 0);
  assert.deepEqual(validateImportedSnapshot(database, snapshot), []);
});

test('incomplete Core mapping leaves the unresolved crosswalk untouched', t => {
  const database = openDatabase();
  t.after(() => database.close());
  importFixedSnapshot(database, sampleSnapshot());
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (2, 'api-football', 'v3');
    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
    VALUES (1, 'af:player:1001', 2, 1001, 'Unresolved Player');
  `);

  assert.throws(() => resolveTrackedPlayerCrosswalk(database, {
    jfwPlayerId: 'jp:unresolved',
    playerCanonicalId: 'af:player:1001',
    memberships: [],
  }), /Every legacy period/);
  assert.equal(database.prepare(`SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = 'jp:unresolved'`).get().crosswalk_state, 'unresolved');
  assert.equal(database.prepare(`SELECT legacy_membership_id IS NOT NULL AS legacy
    FROM tracking_periods WHERE jfw_player_id = 'jp:unresolved'`).get().legacy, 1);
});

test('one-time CLIs create the current fixed file, local D1 database and migration manifest', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-d1-import-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const snapshotPath = path.join(temporary, 'fixed-snapshot.json');
  const databasePath = path.join(temporary, 'local.sqlite3');
  const manifestPath = path.join(temporary, 'migration-manifest.json');
  const root = path.join(__dirname, '..');

  const create = childProcess.spawnSync(process.execPath, [
    'scripts/d1/create-current-fixed-snapshot.js',
    '--output', snapshotPath,
    '--created-at', CREATED_AT,
    '--starts-on', SEASON.startsOn,
    '--ends-on', SEASON.endsOn,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);

  const imported = childProcess.spawnSync(process.execPath, [
    'scripts/d1/import-fixed-snapshot.js',
    '--input', snapshotPath,
    '--database', databasePath,
    '--manifest', manifestPath,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  assert.equal(manifest.inputSha256, artifactSha256(snapshot));
  assert.equal(manifest.payloadSha256, snapshot.inputSha256);
  assert.equal(manifest.inputSha256, require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(snapshotPath)).digest('hex'));
  assert.equal(manifest.counts.trackedPlayers, 64);
  assert.equal(manifest.counts.trackingPeriods, manifest.counts.legacyMemberships);
  assert.equal(manifest.deferred.legacyMatchRecords, 118);
  assert.equal(manifest.productionReady, false);
  assert.deepEqual(manifest.validation.errors, []);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
});
