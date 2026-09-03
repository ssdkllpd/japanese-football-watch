'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { importFixedSnapshot, validateImportedSnapshot } = require('./fixed-snapshot-importer');
const { artifactSha256 } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function ensureSchema(database, rootDirectory) {
  const exists = database.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'provider_sources'`).get();
  if (exists) return;
  for (const file of [
    '0001_d1_core.sql',
    '0002_d1_date_index_coverage.sql',
    '0003_d1_standings_publication.sql',
    '0004_d1_standings_order_and_fixture_date.sql',
  ]) {
    database.exec(fs.readFileSync(path.join(rootDirectory, 'migrations', file), 'utf8'));
  }
}

function databaseCounts(database) {
  const count = table => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    rawSnapshots: count('raw_snapshots'),
    trackedPlayers: count('tracked_players'),
    legacyMemberships: count('legacy_tracking_memberships'),
    trackingPeriods: count('tracking_periods'),
    seasonAggregates: database.prepare(`SELECT COUNT(*) AS count FROM tracked_player_aggregates
      WHERE aggregate_scope = 'season'`).get().count,
  };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--input'] || !args['--database'] || !args['--manifest']) {
    throw new Error('Usage: node scripts/d1/import-fixed-snapshot.js --input FILE --database FILE --manifest FILE');
  }
  const root = path.join(__dirname, '..', '..');
  const snapshot = JSON.parse(fs.readFileSync(args['--input'], 'utf8'));
  const database = new DatabaseSync(args['--database']);
  try {
    ensureSchema(database, root);
    const result = importFixedSnapshot(database, snapshot);
    const errors = validateImportedSnapshot(database, snapshot);
    if (errors.length) throw new Error(`Imported database is invalid:\n- ${errors.join('\n- ')}`);
    const manifest = {
      schemaVersion: 'd1-migration-manifest/1',
      inputPath: args['--input'],
      inputSha256: artifactSha256(snapshot),
      payloadSha256: snapshot.inputSha256,
      importedAt: snapshot.createdAt,
      result,
      counts: databaseCounts(database),
      deferred: {
        legacyMatchRecords: snapshot.data.playerMatchStats.length,
        reason: snapshot.data.playerMatchStats.length
          ? 'Canonical fixture bundles are required; legacy match records were preserved in the fixed snapshot and not guessed into Core facts.'
          : null,
      },
      productionReady: result.productionReady ?? snapshot.data.playerMatchStats.length === 0,
      validation: { errors: [] },
    };
    fs.writeFileSync(args['--manifest'], `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } finally {
    database.close();
  }
}

if (require.main === module) main();

module.exports = { databaseCounts, ensureSchema, main, parseArguments };
