const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mergeBackfillData } = require('../backfill-merge');
const { ROOT, buildBackfillHarness, currentSeasonData, readJson } = require('./helpers/backfill-harness');

function currentInputs() {
  const { season, data } = currentSeasonData();
  const base = path.join('data', season, 'backfill');
  const manifest = readJson(path.join(base, 'index.json'));
  const fragments = manifest.fragments.map(file => readJson(path.join(base, file)));
  return { season, data, fragments };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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

test('current raw data expands to the verified merged parity snapshot', () => {
  const { season, data, fragments } = currentInputs();
  const merged = mergeBackfillData(data, fragments, { season });

  assert.equal(data.players.length, 44);
  assert.equal(data.matches.length, 12);
  assert.equal(data.playerMatchStats?.length || 0, 0);

  assert.equal(merged.players.length, 56);
  assert.equal(merged.matches.length, 27);
  assert.equal(merged.playerMatchStats.length, 61);
  assert.equal(merged.gaResults.length, 12);
  assert.equal(merged.topMatches.length, 7);
  assert.equal(merged.matches.filter(match => match.formationData).length, 27);
  assert.equal(merged.players.filter(player => player.photo).length, 27);
  assert.equal(merged.playerMatchStats.filter(record => record.providerRatings?.apiFootball).length, 43);

  const ito = merged.players.find(player => player.name === '伊東純也');
  assert.ok(ito, '伊東純也 must remain in the merged player registry');
  assert.equal(ito.seasonStats?.assists, 2);
});

test('legacy loader and Node merge entry return identical current-season data', async () => {
  const { season, data, fragments } = currentInputs();
  const expected = mergeBackfillData(data, fragments, { season });
  const context = buildBackfillHarness();

  await context.window.JFWBackfill.initialLoad;

  assert.deepEqual(plain(context.D), expected);
  assert.equal(context.window.JFWBackfill.mergeData, context.window.JFWBackfillMerge.mergeBackfillData);
  const legacyHtml = fs.readFileSync(path.join(ROOT, 'legacy.html'), 'utf8');
  const mergeScript = legacyHtml.indexOf('<script src="backfill-merge.js"></script>');
  const ratingScript = legacyHtml.indexOf('<script src="jfw-rating.js"></script>');
  assert.ok(mergeScript >= 0 && mergeScript < ratingScript, 'legacy must load the merge core before the deferred loader chain');
});
