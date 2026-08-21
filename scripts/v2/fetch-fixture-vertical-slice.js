'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const {
  fixtureIndexEntry,
  normalizeFixtureBundle,
  r2DateIndexKey,
  r2FixtureKey,
  r2FixturePointerKey,
  validateFixtureBundle,
} = require('./fixture-contract');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function flag(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function responseArray(result) {
  return Array.isArray(result?.data?.response) ? result.data.response : [];
}

async function fetchFixtureEnvelope(client, fixtureId) {
  const basic = await client.get('fixtures', { id: fixtureId });
  const baseFixture = responseArray(basic)[0];
  if (!baseFixture) throw new Error(`Fixture ${fixtureId} was not returned by API-Football.`);

  const [events, lineups, players, statistics] = await Promise.all([
    client.get('fixtures/events', { fixture: fixtureId }),
    client.get('fixtures/lineups', { fixture: fixtureId }),
    client.get('fixtures/players', { fixture: fixtureId }),
    client.get('fixtures/statistics', { fixture: fixtureId }),
  ]);

  return {
    fixture: {
      ...baseFixture,
      events: responseArray(events),
      lineups: responseArray(lineups),
      players: responseArray(players),
      statistics: responseArray(statistics),
    },
    quota: {
      basic: basic.quota,
      events: events.quota,
      lineups: lineups.quota,
      players: players.quota,
      statistics: statistics.quota,
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureId = args.fixture || args.fixtureId;
  if (!fixtureId) throw new Error('Use --fixture <API-Football fixture id>.');
  const outputDir = path.resolve(args.out || `.tmp/v2/fixture-${fixtureId}`);
  const client = createClientFromEnv(process.env);
  const envelope = await fetchFixtureEnvelope(client, fixtureId);
  const fetchedAt = new Date().toISOString();
  const finalStatus = ['FT', 'AET', 'PEN'].includes(String(envelope.fixture?.fixture?.status?.short || '').toUpperCase());
  const bundle = normalizeFixtureBundle(envelope.fixture, {
    fetchedAt,
    finalized: finalStatus && flag(args.finalized),
  });
  const errors = validateFixtureBundle(bundle);
  if (errors.length) throw new Error(`Fixture contract validation failed: ${errors.join('; ')}`);

  const canonicalKey = r2FixtureKey(bundle);
  const pointerKey = r2FixturePointerKey(bundle.fixture.id);
  const dateIndexKey = r2DateIndexKey(bundle.fixture.dateJst);
  const pointer = {
    contractVersion: bundle.contractVersion,
    fixtureId: bundle.fixture.id,
    key: canonicalKey,
    updatedAt: fetchedAt,
  };
  const dateIndex = {
    contractVersion: bundle.contractVersion,
    timeZone: bundle.fixture.productTimeZone,
    date: bundle.fixture.dateJst,
    fixtures: [fixtureIndexEntry(bundle)],
    generatedAt: fetchedAt,
  };
  const manifest = {
    fixtureId: bundle.fixture.id,
    providerFixtureId: bundle.fixture.providerId,
    fetchedAt,
    ingestionState: bundle.fixture.ingestionState,
    r2Objects: [
      { role: 'fixture', key: canonicalKey, file: 'fixture.json' },
      { role: 'fixture_pointer', key: pointerKey, file: 'fixture-pointer.json' },
      { role: 'date_index', key: dateIndexKey, file: 'date-index.json' },
    ],
    quota: envelope.quota,
  };

  writeJson(path.join(outputDir, 'fixture.json'), bundle);
  writeJson(path.join(outputDir, 'fixture-pointer.json'), pointer);
  writeJson(path.join(outputDir, 'date-index.json'), dateIndex);
  writeJson(path.join(outputDir, 'manifest.json'), manifest);

  process.stdout.write(`${JSON.stringify({ outputDir, manifest }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchFixtureEnvelope,
  flag,
  parseArgs,
  responseArray,
};
