const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026-27/backfill/latest-2026-08-23-3.json'), 'utf8'));

function ratingEngine() {
  const context = {
    console,
    window: {},
    document: { body: { appendChild() {} }, querySelector() { return null; }, createElement() { return { dataset: {} }; } },
    setTimeout() {},
    clearTimeout() {},
    addEventListener() {}
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'jfw-rating.js'), 'utf8'), context, { filename: 'jfw-rating.js' });
  return context.window.JFWRating;
}

test('Saito QPR-Bolton refinement computes JFW Rating v1.0 from explicit inputs only', () => {
  const record = fragment.playerMatchStats.find(r => r.recordId === 'r-saito-qpr-bolton-20260822');
  assert.ok(record, 'Saito record missing');
  assert.equal(record.values.minutes, 76);
  assert.equal(record.values.goals, 0);
  assert.equal(record.values.assists, 0);
  assert.equal(record.values.keyPasses, 1);

  for (const key of ['yellowCards', 'secondYellowRed', 'straightRed', 'penaltiesConceded', 'ownGoals']) {
    assert.deepEqual(record.ratingInputs[key], {
      state: 'value',
      value: 0,
      sourceId: 'sky-qpr-bolton-live-20260822'
    });
  }

  for (const key of ['dribbles', 'duelsWon', 'duelsTotal', 'bigChancesMissed']) {
    assert.equal(record.ratingInputs[key].state, 'missing', `${key} must remain missing`);
    assert.equal(Object.hasOwn(record.ratingInputs[key], 'value'), false, `${key} must not be zero-filled`);
  }

  const computed = ratingEngine().compute(record.ratingInputs, record.ratingPosition);
  assert.equal(computed.ratingVersion, '1.0');
  assert.equal(computed.jfwRating, 6.08);
  assert.equal(computed.ratingCoverage, 0.764);
  assert.equal(computed.ratingConfidence, 'high');
  assert.deepEqual(Array.from(record.priorityFields), ['dribbles', 'duelsWon', 'duelsTotal', 'bigChancesMissed']);
});
