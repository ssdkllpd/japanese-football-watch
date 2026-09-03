'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const {
  CONTRACT_VERSION,
  PRODUCT_TIME_ZONE,
  fixtureIndexEntry,
  normalizeFixtureBundle,
  r2DateIndexKey,
  r2FixtureKey,
  r2FixturePointerKey,
  validateFixtureBundle,
} = require('./fixture-contract');

const DATE_INDEX_CONTRACT_VERSION = '2.0.0';

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

function assertDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use --date YYYY-MM-DD in JST.');
  return date;
}

function responseArray(result) {
  return Array.isArray(result?.data?.response) ? result.data.response : [];
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function competitionDateIndexKey(competitionId, dateJst) {
  if (!competitionId) throw new Error('Competition ID is required.');
  const date = assertDate(dateJst);
  return `football/v2/indexes/competition/${competitionId}/date-jst/${date}.json`;
}

function feedEntry(bundle) {
  return {
    ...fixtureIndexEntry(bundle),
    competition: {
      id: bundle.competition.id,
      providerId: bundle.competition.providerId,
      name: bundle.competition.name,
      country: bundle.competition.country,
      logo: bundle.competition.logo,
      flag: bundle.competition.flag,
    },
    competitionName: bundle.competition.name,
  };
}

function buildDateFeed(providerFixtures, options = {}) {
  const date = assertDate(options.date);
  const fetchedAt = new Date(options.fetchedAt || Date.now()).toISOString();
  const bundles = [];

  for (const providerFixture of providerFixtures || []) {
    const bundle = normalizeFixtureBundle(providerFixture, { fetchedAt });
    const errors = validateFixtureBundle(bundle);
    if (errors.length) throw new Error(`Fixture ${bundle?.fixture?.providerId ?? 'unknown'} failed validation: ${errors.join('; ')}`);
    if (bundle.fixture.dateJst !== date) continue;
    bundles.push(bundle);
  }

  bundles.sort((a, b) => compareText(a.fixture.kickoffUtc, b.fixture.kickoffUtc)
    || compareText(a.fixture.id, b.fixture.id));
  const entries = bundles.map(feedEntry);
  const dateIndex = {
    contractVersion: DATE_INDEX_CONTRACT_VERSION,
    timeZone: PRODUCT_TIME_ZONE,
    date,
    fixtures: entries,
    generatedAt: fetchedAt,
  };

  const byCompetition = new Map();
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index];
    const entry = entries[index];
    const competitionId = bundle.competition.id;
    if (!byCompetition.has(competitionId)) {
      byCompetition.set(competitionId, {
        contractVersion: DATE_INDEX_CONTRACT_VERSION,
        timeZone: PRODUCT_TIME_ZONE,
        date,
        competition: { ...entry.competition },
        fixtures: [],
        generatedAt: fetchedAt,
      });
    }
    byCompetition.get(competitionId).fixtures.push(entry);
  }

  return {
    date,
    fetchedAt,
    bundles,
    dateIndex,
    competitionIndexes: [...byCompetition.values()],
  };
}

function safeFileSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeDateFeed(outputDir, feed, metadata = {}) {
  const r2Objects = [];
  const root = path.resolve(outputDir);

  writeJson(path.join(root, 'date-index.json'), feed.dateIndex);
  r2Objects.push({
    role: 'date_index',
    key: r2DateIndexKey(feed.date),
    file: 'date-index.json',
    merge: 'date_index',
    mergeScope: 'generic',
    mergeMode: metadata.query?.league ? 'replace-scope' : 'replace',
    mergeReplaceCompetitionId: metadata.query?.league
      ? `af:competition:${metadata.query.league}` : null,
  });

  for (const index of feed.competitionIndexes) {
    const competitionId = index.competition.id;
    const file = `competition-date-indexes/${safeFileSegment(competitionId)}.json`;
    writeJson(path.join(root, file), index);
    r2Objects.push({
      role: 'competition_date_index',
      competitionId,
      key: competitionDateIndexKey(competitionId, feed.date),
      file,
      merge: 'date_index',
      mergeScope: competitionId,
      mergeMode: 'replace',
    });
  }

  for (const bundle of feed.bundles) {
    const providerId = bundle.fixture.providerId;
    const fixtureFile = `fixtures/${safeFileSegment(providerId)}.json`;
    const pointerFile = `fixture-pointers/${safeFileSegment(providerId)}.json`;
    const fixtureKey = r2FixtureKey(bundle);
    const pointer = {
      contractVersion: CONTRACT_VERSION,
      fixtureId: bundle.fixture.id,
      key: fixtureKey,
      updatedAt: feed.fetchedAt,
    };
    writeJson(path.join(root, fixtureFile), bundle);
    writeJson(path.join(root, pointerFile), pointer);
    r2Objects.push({ role: 'fixture', fixtureId: bundle.fixture.id, key: fixtureKey, file: fixtureFile });
    r2Objects.push({
      role: 'fixture_pointer',
      fixtureId: bundle.fixture.id,
      key: r2FixturePointerKey(bundle.fixture.id),
      file: pointerFile,
    });
  }

  const manifest = {
    contractVersion: DATE_INDEX_CONTRACT_VERSION,
    date: feed.date,
    fetchedAt: feed.fetchedAt,
    query: metadata.query || null,
    fixtureCount: feed.bundles.length,
    competitionCount: feed.competitionIndexes.length,
    quota: metadata.quota || null,
    r2Objects,
  };
  writeJson(path.join(root, 'manifest.json'), manifest);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = assertDate(args.date);
  const outputDir = path.resolve(args.out || `.tmp/v2/date-${date}`);
  const query = { date, timezone: PRODUCT_TIME_ZONE };
  if (args.league) query.league = args.league;
  if (args.season) query.season = args.season;

  const client = createClientFromEnv(process.env);
  const result = await client.get('fixtures', query);
  const feed = buildDateFeed(responseArray(result), { date, fetchedAt: new Date().toISOString() });
  const { assertValidDateIndexPayload } = await import('../../shared/date-index-contract.mjs');
  assertValidDateIndexPayload(feed.dateIndex, { expectedDate: date, expectedCompetitionId: null });
  for (const index of feed.competitionIndexes) {
    assertValidDateIndexPayload(index, {
      expectedDate: date,
      expectedCompetitionId: index.competition.id,
    });
  }
  const manifest = writeDateFeed(outputDir, feed, { query, quota: result.quota });
  process.stdout.write(`${JSON.stringify({ outputDir, manifest }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DATE_INDEX_CONTRACT_VERSION,
  assertDate,
  buildDateFeed,
  competitionDateIndexKey,
  feedEntry,
  parseArgs,
  responseArray,
  safeFileSegment,
  writeDateFeed,
};
