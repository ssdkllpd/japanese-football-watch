const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const { mergeBackfillData } = require('../backfill-merge');
const { ROOT, buildBackfillHarness, currentSeasonData, readJson } = require('./helpers/backfill-harness');

const GOLDEN_SEASON = '2026-27';
const GOLDEN_FRAGMENT_NAMES = [
  'core.json',
  'scotland-portugal.json',
  'belgium-stvv.json',
  'eredivisie.json',
  'championship.json',
  'belgium-genk.json',
  'latest-2026-08-20.json',
  'source-fixes-2026-08-20.json',
  'rating-safety-fixes-2026-08-20.json',
  'latest-2026-08-21.json',
  'latest-2026-08-21-2.json',
  'latest-2026-08-21-3.json',
  'latest-2026-08-21-4.json',
  'api-football-existing-results.json',
  'latest-2026-08-21-5.json',
  'latest-2026-08-22.json'
];

function currentInputs() {
  const { season, data } = currentSeasonData();
  const base = path.join('data', season, 'backfill');
  const manifest = readJson(path.join(base, 'index.json'));
  const fragments = manifest.fragments.map(file => readJson(path.join(base, file)));
  return { season, data, fragments, fragmentNames: manifest.fragments };
}

function goldenInputs() {
  const data = readJson('data.json');
  const base = path.join('data', GOLDEN_SEASON, 'backfill');
  const fragments = GOLDEN_FRAGMENT_NAMES.map(file => readJson(path.join(base, file)));
  return { season: GOLDEN_SEASON, data, fragments, fragmentNames: GOLDEN_FRAGMENT_NAMES };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutKnownReplayDrift(value) {
  const data = plain(value);
  for (const player of data.players || []) delete player.statsAsOf;
  for (const record of data.playerMatchStats || []) {
    if (Array.isArray(record.missingFields) && record.missingFields.length === 0) delete record.missingFields;
    if (Array.isArray(record.priorityFields) && record.priorityFields.length === 0) delete record.priorityFields;
    if (record.priorityUpdate === false) delete record.priorityUpdate;
    if (record.providerIds && Object.keys(record.providerIds).length === 0) delete record.providerIds;
    if (record.providerRatings && Object.keys(record.providerRatings).length === 0) delete record.providerRatings;
  }
  return data;
}

test('backfill merge is a pure function and leaves source JSON untouched', () => {
  const { season, data, fragments } = currentInputs();
  const beforeData = plain(data);
  const beforeFragments = plain(fragments);

  const merged = mergeBackfillData(data, fragments, { season });

  assert.notStrictEqual(merged, data);
  assert.deepEqual(data, beforeData);
  assert.deepEqual(fragments, beforeFragments);
});

test('current raw data expands without regressing the verified parity baseline', () => {
  const { season, data, fragments } = currentInputs();
  const merged = mergeBackfillData(data, fragments, { season });

  assert.equal(data.players.length, 44);
  assert.equal(data.matches.length, 12);
  assert.equal(data.playerMatchStats?.length || 0, 0);

  assert.ok(merged.players.length >= 56);
  assert.ok(merged.matches.length >= 27);
  assert.ok(merged.playerMatchStats.length >= 61);
  assert.ok(merged.gaResults.length >= 12);
  assert.ok(merged.topMatches.length >= 7);
  assert.ok(merged.matches.filter(match => match.formationData).length >= 27);
  assert.ok(merged.players.filter(player => player.photo).length >= 27);
  assert.ok(merged.playerMatchStats.filter(record => record.providerRatings?.apiFootball).length >= 42);

  const ito = merged.players.find(player => player.name === '伊東純也');
  assert.ok(ito, '伊東純也 must remain in the merged player registry');
  assert.ok(Number(ito.seasonStats?.assists) >= 2, 'verified 伊東純也 A2 baseline must not regress');
});

test('pinned 49c70c3 inputs still match the golden legacy-loader output exactly', () => {
  const { season, data, fragments } = goldenInputs();
  const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'backfill-merged-49c70c3.json.gz'));
  const expected = JSON.parse(zlib.gunzipSync(fixture).toString('utf8'));

  assert.deepEqual(mergeBackfillData(data, fragments, { season }), expected);
});

// A second application currently changes statsAsOf annotations and introduces
// empty normalized record fields. Fixing that is a post-parity contract change.
test.todo('reapplying the same backfill is fully idempotent without changing first-pass legacy parity');

test('known replay drift is limited to annotations and empty normalization fields', () => {
  const { season, data, fragments } = currentInputs();
  const once = mergeBackfillData(data, fragments, { season });
  const twice = mergeBackfillData(once, fragments, { season });

  assert.notDeepEqual(twice, once);
  assert.deepEqual(withoutKnownReplayDrift(twice), withoutKnownReplayDrift(once));
});

test('pinned source id overrides stay explicit and exhaustive coverage cannot shrink unnoticed', () => {
  const { fragments, fragmentNames } = goldenInputs();
  const seen = new Map();
  const overrides = [];

  for (const [index, fragment] of fragments.entries()) {
    for (const [id, source] of Object.entries(fragment.sources || {})) {
      const previous = seen.get(id);
      if (previous && JSON.stringify(previous.source) !== JSON.stringify(source)) {
        const currentCoverage = new Set(source.exhaustiveFor || []);
        overrides.push({
          id,
          from: previous.fragment,
          to: fragmentNames[index],
          removedCoverage: (previous.source.exhaustiveFor || []).filter(field => !currentCoverage.has(field))
        });
      }
      seen.set(id, { fragment: fragmentNames[index], source });
    }
  }

  assert.deepEqual(overrides, [
    {
      id: 'elbotola-genk-westerlo',
      from: 'belgium-genk.json',
      to: 'latest-2026-08-20.json',
      removedCoverage: ['assists']
    },
    {
      id: 'southampton-colchester',
      from: 'latest-2026-08-20.json',
      to: 'source-fixes-2026-08-20.json',
      removedCoverage: []
    },
    {
      id: 'fwp-swansea-birmingham',
      from: 'latest-2026-08-20.json',
      to: 'source-fixes-2026-08-20.json',
      removedCoverage: []
    },
    {
      id: 'fwp-burton-blackburn',
      from: 'latest-2026-08-20.json',
      to: 'source-fixes-2026-08-20.json',
      removedCoverage: []
    },
    {
      id: 'fwp-kilmarnock-celtic',
      from: 'latest-2026-08-20.json',
      to: 'source-fixes-2026-08-20.json',
      removedCoverage: []
    }
  ]);
});

test('CommonJS import does not publish the browser global', () => {
  const context = { module: { exports: {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-merge.js'), 'utf8'), context);

  assert.equal(context.JFWBackfillMerge, undefined);
  assert.equal(typeof context.module.exports.mergeBackfillData, 'function');
});

test('legacy loader and Node merge entry return identical current-season data', async () => {
  const { season, data, fragments } = currentInputs();
  const expected = mergeBackfillData(data, fragments, { season });
  const context = buildBackfillHarness();

  await context.window.JFWBackfill.initialLoad;

  assert.deepEqual(plain(context.getData()), expected);
  assert.equal(context.window.JFWBackfill.mergeData, context.window.JFWBackfillMerge.mergeBackfillData);
  const legacyHtml = fs.readFileSync(path.join(ROOT, 'legacy.html'), 'utf8');
  const mergeScript = legacyHtml.indexOf('<script src="backfill-merge.js"></script>');
  const ratingScript = legacyHtml.indexOf('<script src="jfw-rating.js"></script>');
  assert.ok(mergeScript >= 0 && mergeScript < ratingScript, 'legacy must load the merge core before the deferred loader chain');
});
